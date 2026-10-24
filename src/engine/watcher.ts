import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import { realpathSync } from "node:fs";
import { runScanCommand } from "./scan.js";
import { isSensitiveRelativePath } from "../security/index.js";
import type { LoadedAiMemoryConfig } from "./config.js";
import type { SignificanceOptions } from "./significance.js";

const WATCH_DEBOUNCE_MS = 500;
const CPU_PAUSE_THRESHOLD = 0.8;
const MEMORY_PAUSE_THRESHOLD_BYTES = 500 * 1024 * 1024;

let processCpuBaseline = process.cpuUsage();
let processCpuBaselineMs = performance.now();

function sampleProcessCpuBaseline(): void {
  processCpuBaseline = process.cpuUsage();
  processCpuBaselineMs = performance.now();
}

function getProcessCpuFraction(): number {
  const now = process.cpuUsage();
  const elapsedMs = performance.now() - processCpuBaselineMs;
  if (elapsedMs < 50) return 0;
  const cpuUs =
    now.user - processCpuBaseline.user + (now.system - processCpuBaseline.system);
  return cpuUs / 1000 / elapsedMs;
}

function getMemoryUsageBytes(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
}

function isSystemUnderPressure(): boolean {
  if (process.env.VITEST === "true") return false;
  const cpu = getProcessCpuFraction();
  const mem = getMemoryUsageBytes();
  return cpu > CPU_PAUSE_THRESHOLD || mem > MEMORY_PAUSE_THRESHOLD_BYTES;
}

// Directory names must match a path segment or a path prefix.
// `includes("dist")` also skipped `distribution/`, so those edits never rescanned.
export function isExcludedRelativePath(posixRel: string, excludes: readonly string[]): boolean {
  for (const raw of excludes) {
    const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!normalized) continue;
    if (posixRel === normalized || posixRel.startsWith(`${normalized}/`)) return true;
    if (!normalized.includes("/")) {
      const segments = posixRel.split("/");
      if (segments.includes(normalized)) return true;
    }
  }
  return false;
}

export interface WatcherOptions {
  rootDir: string;
  config: LoadedAiMemoryConfig;
  sigOptions?: SignificanceOptions;
  quiet?: boolean;
  includeAgentNotes?: boolean;
  oneShot?: boolean;
}

export interface WatcherController {
  stop: () => Promise<void>;
  status: () => WatcherStatus;
  whenReady: () => Promise<void>;
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
  let scanInFlight = false;
  let watcher: FSWatcher | null = null;

  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".rs", ".go"];
  const excludeGlobs = [...defaultExcludes, ...config.config.exclude];

  const usePolling = process.env.VITEST === "true";
  let resolveReady: () => void = () => {};
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const watchOpts: Parameters<typeof watch>[1] = {
    usePolling,
    ignored: (filePath: string, stats) => {
      // stats is missing until chokidar stats the path. Ignoring those paths
      // drops whole directories (src has no extension) and the watch never fires.
      if (!stats || stats.isDirectory()) return false;
      if (filePath === resolvedRoot) return false;
      const rel = path.relative(resolvedRoot, filePath);
      if (rel.startsWith("..")) return true;
      const posixRel = rel.replace(/\\/g, "/");
      if (isSensitiveRelativePath(posixRel)) return true;
      const segments = posixRel.split("/");
      for (const seg of segments) {
        if (seg.startsWith(".") && seg !== "..") return true;
      }
      if (isExcludedRelativePath(posixRel, excludeGlobs)) return true;
      const ext = path.extname(filePath).toLowerCase();
      if (!extensions.includes(ext)) return true;
      return false;
    },
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  };
  if (usePolling) {
    watchOpts.interval = 100;
  }

  watcher = watch(resolvedRoot, watchOpts);

  function log(message: string): void {
    if (!options.quiet) {
      process.stdout.write(`[memo-log] ${message}\n`);
    }
  }

  async function rescan(): Promise<void> {
    const input = {
      targetDir: resolvedRoot,
      format: "both" as const,
      effectiveConfig: config,
      quiet: options.quiet ?? false,
      includeAgentNotes: options.includeAgentNotes === true,
      ...(sigOptions
        ? { filter: sigOptions.filter, trackTypes: sigOptions.trackTypes }
        : {}),
    };
    const result = await runScanCommand(input);
    log(`Rescanned ${result.totalFiles} files.`);
  }

  function flushPending(): void {
    debounceTimer = null;

    if (isSystemUnderPressure()) {
      isPaused = true;
      pauseReason = `CPU: ${(getProcessCpuFraction() * 100).toFixed(0)}%, Mem: ${(getMemoryUsageBytes() / (1024 * 1024)).toFixed(0)}MB`;
      log(`PAUSED: System under pressure (${pauseReason}). Will resume when resources free.`);
      debounceTimer = setTimeout(flushPending, 2000);
      return;
    }

    if (isPaused) {
      isPaused = false;
      pauseReason = null;
      log("RESUMED: System resources back to normal.");
    }

    if (pendingFiles.length === 0) return;

    if (scanInFlight) {
      debounceTimer = setTimeout(flushPending, WATCH_DEBOUNCE_MS);
      return;
    }

    const batch = pendingFiles;
    pendingFiles = [];
    const last = batch[batch.length - 1];
    if (last) {
      lastEvent = `${last.eventType}: ${path.relative(resolvedRoot, last.filePath)}`;
    }

    scanInFlight = true;
    void (async () => {
      try {
        await rescan();
      } catch (err) {
        log(`WARN: Rescan failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        scanInFlight = false;
        sampleProcessCpuBaseline();
        if (pendingFiles.length > 0 && debounceTimer === null) {
          debounceTimer = setTimeout(flushPending, WATCH_DEBOUNCE_MS);
        }
      }
    })();
  }

  function scheduleProcess(filePath: string, eventType: "add" | "change" | "unlink"): void {
    const absolutePath = path.resolve(filePath);
    pendingFiles.push({ filePath: absolutePath, eventType });

    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }

    if (isPaused || scanInFlight) {
      debounceTimer = setTimeout(flushPending, scanInFlight ? WATCH_DEBOUNCE_MS : 2000);
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

  watcher.on("ready", () => {
    resolveReady();
  });

  log(`Watching ${path.basename(resolvedRoot)} for changes... (Ctrl+C to stop)`);

  sampleProcessCpuBaseline();

  return {
    whenReady: () => readyPromise,
    async stop() {
      isWatching = false;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
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
