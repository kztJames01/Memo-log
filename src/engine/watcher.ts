import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import { cpus } from "node:os";

import { loadCache, saveCache, createEmptyCache, type ProjectCache } from "./cache.js";
import { resolveExtractForFile, removeCacheEntry } from "./cachedParse.js";
import { safeReadFile } from "../security/safeRead.js";
import { normalizeRelativePath } from "../security/index.js";
import type { LoadedAiMemoryConfig } from "./config.js";
import type { AstExtract } from "../types/scan.js";
import type { SignificanceOptions } from "./significance.js";
import {
  buildCurrentState,
  loadState,
  writeStateAtomic,
} from "./diff.js";
import { generateDualOutput, renderMarkdown } from "../output/dual-generator.js";
import { validateOutput } from "./anti-hallucination.js";

const WATCH_DEBOUNCE_MS = 500;
const MAX_CONCURRENT_PARSES = 10;
const CPU_PAUSE_THRESHOLD = 0.8;
const MEMORY_PAUSE_THRESHOLD_BYTES = 500 * 1024 * 1024;

let cpuSnapshotIdle = 0;
let cpuSnapshotTick = 0;

function sampleCpuStart(): void {
  let idle = 0;
  let tick = 0;
  for (const cpu of cpus()) {
    for (const type of Object.keys(cpu.times)) {
      tick += (cpu.times as Record<string, number>)[type] ?? 0;
    }
    idle += cpu.times.idle;
  }
  cpuSnapshotIdle = idle;
  cpuSnapshotTick = tick;
}

function getCpuUsageDelta(): number {
  let idle = 0;
  let tick = 0;
  for (const cpu of cpus()) {
    for (const type of Object.keys(cpu.times)) {
      tick += (cpu.times as Record<string, number>)[type] ?? 0;
    }
    idle += cpu.times.idle;
  }
  const idleDiff = idle - cpuSnapshotIdle;
  const tickDiff = tick - cpuSnapshotTick;
  if (tickDiff === 0) return 0;
  return 1 - idleDiff / tickDiff;
}

function getMemoryUsageBytes(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
}

function isSystemUnderPressure(): boolean {
  const cpu = getCpuUsageDelta();
  const mem = getMemoryUsageBytes();
  return cpu > CPU_PAUSE_THRESHOLD || mem > MEMORY_PAUSE_THRESHOLD_BYTES;
}

export interface WatcherOptions {
  rootDir: string;
  config: LoadedAiMemoryConfig;
  sigOptions?: SignificanceOptions;
  quiet?: boolean;
  oneShot?: boolean;
}

export interface WatcherController {
  stop: () => Promise<void>;
  status: () => WatcherStatus;
}

export interface WatcherStatus {
  watching: boolean;
  pendingEvents: number;
  filesTracked: number;
  lastEvent: string | null;
  paused: boolean;
  pauseReason: string | null;
}

interface PendingFile {
  filePath: string;
  eventType: "add" | "change" | "unlink";
}

export function startWatcher(options: WatcherOptions): WatcherController {
  const { rootDir, config, sigOptions } = options;
  const resolvedRoot = realpathSync(rootDir);
  const stateDir = ".memo-log";
  const defaultExcludes = ["node_modules", ".git", "dist", "build", "coverage", stateDir];

  let isWatching = true;
  let isPaused = false;
  let pauseReason: string | null = null;
  let lastEvent: string | null = null;
  let pendingFiles: PendingFile[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  const projectCache: ProjectCache = loadCache(resolvedRoot) ?? createEmptyCache();

  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".rs", ".go"];
  const excludeGlobs = [...defaultExcludes, ...config.config.exclude];

  watcher = watch(resolvedRoot, {
    ignored: (filePath: string, stats) => {
      if (stats?.isDirectory() ?? false) return false;
      if (filePath === resolvedRoot) return false;
      const ext = path.extname(filePath).toLowerCase();
      if (ext === "" || ext.length > 6) return false;
      const rel = path.relative(resolvedRoot, filePath);
      if (rel.startsWith("..")) return true;
      const segments = rel.replace(/\\/g, "/").split("/");
      for (const seg of segments) {
        if (seg.startsWith(".") && seg !== "..") return true;
      }
      for (const excl of excludeGlobs) {
        if (rel.includes(excl)) return true;
      }
      if (extensions.every((e) => !filePath.endsWith(e))) return true;
      return false;
    },
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  function log(message: string): void {
    if (!options.quiet) {
      process.stdout.write(`[memo-log] ${message}\n`);
    }
  }

  async function processFile(filePath: string, eventType: "add" | "change" | "unlink"): Promise<void> {
    lastEvent = `${eventType}: ${path.relative(resolvedRoot, filePath)}`;

    if (eventType === "unlink") {
      const previousState = loadState(resolvedRoot);
      if (!previousState) return;
      const normalized = filePath.replace(/\\/g, "/");
      const relPath = path.relative(resolvedRoot, filePath).replace(/\\/g, "/");
      if (previousState.files[normalized] || previousState.files[relPath]) {
        delete previousState.files[normalized];
        delete previousState.files[relPath];
        writeStateAtomic(previousState, resolvedRoot);
        removeCacheEntry(projectCache, relPath);
        saveCache(projectCache, resolvedRoot);
        log(`File removed: ${relPath}`);
        await rewriteOutputs(resolvedRoot, config);
      }
      return;
    }

    let content: string;
    let fileSize: number;
    try {
      const result = await safeReadFile(filePath);
      content = result.content;
      fileSize = result.size;
    } catch (err) {
      log(`WARN: Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const previousState = loadState(resolvedRoot);
    const relPath = normalizeRelativePath(path.relative(resolvedRoot, filePath));

    const resolved = await resolveExtractForFile(
      filePath,
      relPath,
      content,
      fileSize,
      projectCache,
      sigOptions,
    );

    if (!resolved.extract) {
      removeCacheEntry(projectCache, relPath);
      saveCache(projectCache, resolvedRoot);
      return;
    }

    const extract = resolved.extract;

    const currentExtracts: AstExtract[] = [extract];

    const newState = buildCurrentState(currentExtracts);

    if (previousState) {
      for (const [key, val] of Object.entries(previousState.files)) {
        if (relPath !== key && relPath !== normalizeRelativePath(key)) {
          newState.files[key] = val;
        }
      }
    }

    writeStateAtomic(newState, resolvedRoot);
    projectCache.lastScan = new Date().toISOString();
    saveCache(projectCache, resolvedRoot);
    const cacheNote = resolved.fromCache ? " (cache hit)" : "";
    log(`File ${eventType === "add" ? "added" : "changed"}: ${relPath}${cacheNote}`);
    await rewriteOutputs(resolvedRoot, config);
  }

  async function rewriteOutputs(root: string, cfg: LoadedAiMemoryConfig): Promise<void> {
    const state = loadState(root);

    const allExtracts: AstExtract[] = [];
    if (state) {
      for (const [filePath] of Object.entries(state.files)) {
        const absolutePath = path.resolve(root, filePath);
        let content: string;
        let fileSize: number;
        try {
          const result = await safeReadFile(absolutePath);
          content = result.content;
          fileSize = result.size;
        } catch {
          continue;
        }

        try {
          const resolved = await resolveExtractForFile(
            absolutePath,
            filePath,
            content,
            fileSize,
            projectCache,
            sigOptions,
          );
          if (!resolved.extract) continue;
          allExtracts.push(resolved.extract);
        } catch {
          continue;
        }
      }
    }

    const snapshot = generateDualOutput(allExtracts, "dual", root, { generatedAt: new Date().toISOString() });
    const validatedSnapshot = validateOutput(snapshot, root);

    const markdown = renderMarkdown(validatedSnapshot, "dual");

    const defaultMarkdownPath = path.resolve(root, cfg.config.output.markdown);
    const defaultJsonPath = path.resolve(root, cfg.config.output.json);

    try {
      await writeFileAtomic(defaultJsonPath, `${JSON.stringify(validatedSnapshot, null, 2)}\n`);
      await writeFileAtomic(defaultMarkdownPath, `${markdown}\n`);
      projectCache.lastScan = new Date().toISOString();
      saveCache(projectCache, root);
    } catch (err) {
      log(`WARN: Failed to write output: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function writeFileAtomic(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempFilePath = path.join(path.dirname(filePath), `.memo-log-tmp-${Date.now()}.tmp`);
    await fs.writeFile(tempFilePath, content, "utf8");
    await fs.rename(tempFilePath, filePath);
  }

  function flushPending(): void {
    debounceTimer = null;

    if (isSystemUnderPressure()) {
      isPaused = true;
      pauseReason = `CPU: ${(getCpuUsageDelta() * 100).toFixed(0)}%, Mem: ${(getMemoryUsageBytes() / (1024*1024)).toFixed(0)}MB`;
      log(`PAUSED: System under pressure (${pauseReason}). Will resume when resources free.`);
      return;
    }

    if (isPaused) {
      isPaused = false;
      pauseReason = null;
      log("RESUMED: System resources back to normal.");
    }

    if (pendingFiles.length === 0) return;

    const deduplicated = new Map<string, PendingFile>();
    for (const pf of pendingFiles) {
      const key = pf.filePath;
      const existing = deduplicated.get(key);
      if (!existing || pf.eventType === "unlink") {
        deduplicated.set(key, pf);
      }
    }
    pendingFiles = [];

    const batch = [...deduplicated.values()].slice(0, MAX_CONCURRENT_PARSES);

    (async () => {
      for (const pf of batch) {
        try {
          await processFile(pf.filePath, pf.eventType);
        } catch (err) {
          log(`WARN: Failed to process ${pf.filePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (isPaused) {
        setTimeout(flushPending, 2000);
      }
    })();
  }

  function scheduleProcess(filePath: string, eventType: "add" | "change" | "unlink"): void {
    const absolutePath = path.resolve(filePath);
    pendingFiles.push({ filePath: absolutePath, eventType });

    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }

    if (isPaused) {
      debounceTimer = setTimeout(flushPending, 2000);
    } else {
      debounceTimer = setTimeout(flushPending, WATCH_DEBOUNCE_MS);
    }
  }

  watcher.on("add", (filePath: string) => {
    scheduleProcess(filePath, "add");
  });

  watcher.on("change", (filePath: string) => {
    scheduleProcess(filePath, "change");
  });

  watcher.on("unlink", (filePath: string) => {
    scheduleProcess(filePath, "unlink");
  });

  watcher.on("error", (error: unknown) => {
    log(`WARN: Watcher error: ${error instanceof Error ? error.message : String(error)}`);
  });

  log(`Watching ${path.basename(resolvedRoot)} for changes... (Ctrl+C to stop)`);

  sampleCpuStart();

  return {
    async stop() {
      isWatching = false;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      if (watcher !== null) {
        await watcher.close();
      }
      log("Watcher stopped.");
    },
    status(): WatcherStatus {
      return {
        watching: isWatching,
        pendingEvents: pendingFiles.length,
        filesTracked: watcher !== null ? 1 : 0,
        lastEvent,
        paused: isPaused,
        pauseReason,
      };
    },
  };
}
