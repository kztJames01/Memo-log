// runs the end-to-end scan pipeline and writes deterministic outputs.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { generateDualOutput, renderBriefMode, renderMarkdown } from "../output/dual-generator.js";
import {
  loadCache,
  saveCache,
  createEmptyCache,
  updateCalibration,
  type ProjectCache,
} from "./cache.js";
import { resolveExtractForFile } from "./cachedParse.js";
import { walkDirectory, normalizeRelativePath } from "../security/index.js";
import { safeReadFile, WarningLimiter, buildManifestSizeMap } from "../security/safeRead.js";
import type { ScanManifest } from "../security/types.js";
import type { LoadedAiMemoryConfig } from "./config.js";
import { validateOutput } from "./anti-hallucination.js";
import { CliError, ExitCode } from "./errors.js";
import type { AstExtract, StructuralScanOptions } from "../types/scan.js";
import {
  diffStates,
  buildCurrentState,
  loadState,
  writeStateAtomic,
  appendRecentChanges,
  validateNoStaleReferences,
  getDiffSummary,
  appendHistoryEvent,
  renderChangeHistory,
  loadHistory,
  type DiffResult,
} from "./diff.js";
import type { SignificanceOptions } from "./significance.js";
import { CommitGrouper } from "./commit-grouper.js";
import type { GitChange } from "./git.js";
import { GitService } from "./git.js";

export type { AstExtract, StructuralScanOptions } from "../types/scan.js";

export type OutputFormat = "md" | "json" | "both";
export type ScanMode = "tech" | "simple" | "dual" | "brief";

export interface ScanExecutionOptions {
  targetDir: string;
  mode?: ScanMode | undefined;
  out?: string | undefined;
  format?: OutputFormat | undefined;
  config?: string | undefined;
  maxDepth?: number | undefined;
  timeoutMs?: number | undefined;
  maxFileSizeBytes?: number | undefined;
  includeAgentNotes?: boolean | undefined;
  quiet?: boolean | undefined;
  filter?: string | undefined;
  trackTypes?: boolean | undefined;
}

export interface RunScanCommandInput extends ScanExecutionOptions {
  effectiveConfig: LoadedAiMemoryConfig;
}

export interface RunScanCommandResult {
  markdownPath?: string | undefined;
  jsonPath?: string | undefined;
  warnings: string[];
  totalFiles: number;
  diffSummary?: string | undefined;
}

interface StructuralScanDetails {
  extracts: AstExtract[];
  warnings: string[];
  manifest: ScanManifest;
}

interface AgentNote {
  source: string;
  body: string;
  format: "markdown" | "json" | "text";
}

const FILE_BATCH_SIZE = 10;
const DEFAULT_SCAN_EXCLUDES = ["node_modules", ".git", "dist", "build", "coverage", "MEMO_LOG.*"] as const;
const MAX_AGENT_NOTE_BYTES = 64 * 1024;

export async function runScanCommand(
  input: RunScanCommandInput,
): Promise<RunScanCommandResult> {
  const loadedConfig = input.effectiveConfig;
  const rootDir = loadedConfig.rootDir;
  const config = loadedConfig.config;
  const format = input.format ?? "both";
  const mode = normalizeMode(input.mode ?? config.mode);

  validateOutputPathOverride(format, input.out);

  const previousState = loadState(rootDir);

  const runtimeExcludes = buildRuntimeExcludes(config, input.out);
  const sigOptions: SignificanceOptions = {
    filter: (input.filter as "trivial" | "logic" | "all" | undefined) ?? config.filter ?? "logic",
    trackTypes: input.trackTypes ?? config.trackTypes ?? false,
  };
  const scanDetails = await runStructuralScanWithDetails(rootDir, {
    timeoutMs: input.timeoutMs,
    maxDepth: input.maxDepth ?? config.maxDepth,
    maxFileSizeBytes: input.maxFileSizeBytes,
    excludes: runtimeExcludes,
  }, sigOptions);

  const outputMode = mode === "brief" ? "simple" : mode;
  const generatedAt = new Date().toISOString();
  const snapshot = generateDualOutput(scanDetails.extracts, outputMode, rootDir, { generatedAt });

  const warningLimiter = new WarningLimiter();
  const mergedWarnings: string[] = [...snapshot.warnings];
  for (const warning of scanDetails.warnings) {
    warningLimiter.emit(mergedWarnings, warning);
  }

  const agentNotes =
    input.includeAgentNotes === true
      ? await collectAgentNotes(rootDir, warningLimiter, mergedWarnings)
      : [];
  warningLimiter.flush(mergedWarnings);
  snapshot.warnings = mergedWarnings;

  const validatedSnapshot = validateOutput(snapshot, rootDir);

  const diffResult = diffStates(scanDetails.extracts, previousState);

  const staleRefViolations = validateNoStaleReferences(validatedSnapshot, diffResult);
  for (const violation of staleRefViolations) {
    warningLimiter.emit(mergedWarnings, violation);
  }

  const markdown = mode === "brief"
    ? renderBriefMode(validatedSnapshot)
    : renderMarkdown(validatedSnapshot, outputMode);

  let markdownWithChanges = previousState !== null
    ? appendRecentChanges(markdown, diffResult, rootDir)
    : markdown;

  const history = appendHistoryEvent(rootDir, diffResult, generatedAt);
  const existingHistory = history.events.length > 0 ? history : loadHistory(rootDir);
  const historySection = renderChangeHistory(existingHistory);
  if (historySection.length > 0) {
    markdownWithChanges = `${markdownWithChanges.trimEnd()}\n\n${historySection}\n`;
  }

  const markdownWithNotes = agentNotes.length > 0
    ? appendSessionNotes(markdownWithChanges, agentNotes)
    : markdownWithChanges;

  const changedGitLike = toGitChanges(diffResult);
  const dependencyCommitGroups = CommitGrouper.groupChangesByDependency(changedGitLike, scanDetails.extracts);
  const markdownWithCommitSuggestions = appendCommitSuggestions(markdownWithNotes, dependencyCommitGroups, rootDir);

  const explicitOut = resolveOutputOverride(rootDir, input.out);
  const writeMarkdown = format === "md" || format === "both";
  const writeJson = format === "json" || format === "both";
  const defaultMarkdownPath = path.resolve(rootDir, config.output.markdown);
  const defaultJsonPath = path.resolve(rootDir, config.output.json);

  let markdownPath: string | undefined;
  let jsonPath: string | undefined;

  if (writeJson) {
    jsonPath = explicitOut?.json ?? defaultJsonPath;
    await writeFileAtomic(jsonPath, `${JSON.stringify(validatedSnapshot, null, 2)}\n`);
  }

  if (writeMarkdown) {
    markdownPath = explicitOut?.markdown ?? defaultMarkdownPath;
    await writeFileAtomic(markdownPath, `${markdownWithCommitSuggestions}\n`);
  }
  // persist fresh state after outputs are written successfully.
  const currentState = buildCurrentState(scanDetails.extracts);
  writeStateAtomic(currentState, rootDir);

  if (!input.quiet) {
    if (validatedSnapshot.warnings.length > 0) {
      for (const warning of validatedSnapshot.warnings) {
        console.warn(warning);
      }
    }
    const summary = getDiffSummary(diffResult);
    if (summary !== "no changes" && previousState !== null) {
      console.log(`Changes since last scan: ${summary}`);
    }
  }

  return {
    markdownPath,
    jsonPath,
    warnings: validatedSnapshot.warnings,
    totalFiles: scanDetails.manifest.files.length,
    diffSummary: previousState !== null ? getDiffSummary(diffResult) : undefined,
  };
}
// public scan helper used by cli and tests.
export async function runStructuralScan(
  targetDir: string,
  options: StructuralScanOptions = {},
  sigOptions?: SignificanceOptions,
): Promise<AstExtract[]> {
  const details = await runStructuralScanWithDetails(targetDir, options, sigOptions);
  if (!options.quiet) {
    for (const warning of details.warnings) {
      console.warn(warning);
    }
  }
  return details.extracts;
}
// internal scanner that returns extracts plus manifest-level details.
async function runStructuralScanWithDetails(
  targetDir: string,
  options: StructuralScanOptions = {},
  sigOptions?: SignificanceOptions,
): Promise<StructuralScanDetails> {
  const resolvedTargetDir = path.resolve(targetDir);
  // Use async fs.access instead of sync accessSync
  try {
    await fs.access(resolvedTargetDir);
  } catch (error) {
    throw new CliError(
      `INVALID_TARGET_DIR: ${resolvedTargetDir} is not readable (${error instanceof Error ? error.message : String(error)})`,
      ExitCode.ConfigError,
    );
  }
  const targetStats = await fs.stat(resolvedTargetDir).catch((error: unknown) => {
    throw new CliError(
      `INVALID_TARGET_DIR: ${resolvedTargetDir} (${error instanceof Error ? error.message : String(error)})`,
      ExitCode.ConfigError,
    );
  });

  if (!targetStats.isDirectory()) {
    throw new CliError(`INVALID_TARGET_DIR: ${resolvedTargetDir} is not a directory`, ExitCode.ConfigError);
  }

  const walkerOptions = {
    rootPath: resolvedTargetDir,
    excludes: options.excludes ?? [...DEFAULT_SCAN_EXCLUDES],
    maxDepth: options.maxDepth ?? 10,
    timeoutMs: options.timeoutMs ?? 30000,
    ...(options.maxFileSizeBytes !== undefined ? { maxFileSizeBytes: options.maxFileSizeBytes } : {}),
  };

  const manifest = await walkDirectory(walkerOptions);
  const sizeMap = buildManifestSizeMap(manifest.entries);
  const extracts: AstExtract[] = [];
  const warningLimiter = new WarningLimiter();
  const warnings: string[] = [...manifest.warnings];
  const files = manifest.files;
  const projectCache: ProjectCache = loadCache(resolvedTargetDir) ?? createEmptyCache();
  let totalParseMs = 0;
  let parsedFileCount = 0;
  const concurrency = projectCache.calibration.concurrency;

  for (let i = 0; i < files.length; i += FILE_BATCH_SIZE) {
    const batch = files.slice(i, i + FILE_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (filePath) => {
        const expectedSize = sizeMap.get(filePath);
        const { content, size } = await safeReadFile(filePath, { expectedSize });
        return { filePath, content, size };
      }),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const filePath = batch[j];
      if (!result || !filePath) {
        continue;
      }

      if (result.status === "rejected") {
        const reason = result.reason;
        warningLimiter.emit(warnings, `WARN: Failed to read ${filePath}: ${reason instanceof Error ? reason.message : String(reason)}`);
        continue;
      }

      try {
        const relativeFilePath = normalizeRelativePath(path.relative(manifest.rootPath, filePath));
        const resolved = await resolveExtractForFile(
          filePath,
          relativeFilePath,
          result.value.content,
          result.value.size,
          projectCache,
          sigOptions,
        );
        totalParseMs += resolved.parseMs;
        if (!resolved.fromCache) {
          parsedFileCount += 1;
        }
        for (const parseWarning of resolved.warnings) {
          warningLimiter.emit(warnings, parseWarning);
        }

        if (!resolved.extract) {
          continue;
        }

        extracts.push(resolved.extract);
      } catch (error) {
        warningLimiter.emit(
          warnings,
          `WARN: Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  warningLimiter.flush(warnings);

  projectCache.lastScan = new Date().toISOString();
  updateCalibration(projectCache, totalParseMs, parsedFileCount > 0 ? parsedFileCount : files.length, concurrency);
  saveCache(projectCache, resolvedTargetDir);

  return {
    extracts,
    warnings,
    manifest,
  };
}

function buildRuntimeExcludes(
  config: LoadedAiMemoryConfig["config"],
  outputPath: string | undefined,
): string[] {
  const runtimeExcludes = [...config.exclude];

  if (outputPath !== undefined) {
    runtimeExcludes.push(outputPath);
  } else {
    runtimeExcludes.push(config.output.markdown);
    runtimeExcludes.push(config.output.json);
  }

  return runtimeExcludes;
}

function resolveOutputOverride(
  rootDir: string,
  outputPath: string | undefined,
): { json?: string; markdown?: string } | undefined {
  if (outputPath === undefined) {
    return undefined;
  }

  const resolvedPath = path.resolve(rootDir, outputPath);
  return {
    json: resolvedPath,
    markdown: resolvedPath,
  };
}

function normalizeMode(mode: ScanMode): ScanMode {
  if (mode === "dual" || mode === "brief" || mode === "tech" || mode === "simple") {
    return mode;
  }
  return "tech";
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFilePath = path.join(path.dirname(filePath), `.memo-log-${randomUUID()}.tmp`);
  await fs.writeFile(tempFilePath, content, "utf8");
  await fs.rename(tempFilePath, filePath);
}

async function collectAgentNotes(
  targetDir: string,
  warningLimiter: WarningLimiter,
  warningsOut: string[],
): Promise<AgentNote[]> {
  const candidates: Array<{ source: string; format: AgentNote["format"] }> = [
    { source: "CLAUDE.md", format: "markdown" },
    { source: "AGENTS.md", format: "markdown" },
    { source: "Agents.md", format: "markdown" },
    { source: ".cursor/summary.json", format: "json" },
  ];

  const notes: AgentNote[] = [];
  for (const candidate of candidates) {
    const absolutePath = path.join(targetDir, candidate.source);

    let stats;
    try {
      // Use async fs.access instead of sync accessSync
      await fs.access(absolutePath);
      stats = await fs.stat(absolutePath);
    } catch {
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    if (stats.size > MAX_AGENT_NOTE_BYTES) {
      warningLimiter.emit(
        warningsOut,
        `WARN: Agent note skipped (too large): ${candidate.source} (${stats.size} bytes)`,
      );
      continue;
    }

    try {
      const body = await fs.readFile(absolutePath, "utf8");
      notes.push({
        source: candidate.source,
        format: candidate.format,
        body: body.trim(),
      });
      warningLimiter.emit(
        warningsOut,
        `WARN: Included unverified agent metadata from ${candidate.source}`,
      );
    } catch (error) {
      warningLimiter.emit(
        warningsOut,
        `WARN: Failed to read agent note ${candidate.source}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  notes.sort((a, b) => a.source.localeCompare(b.source));
  return notes;
}

function appendSessionNotes(markdown: string, notes: AgentNote[]): string {
  const lines: string[] = [markdown.trimEnd(), "", "## Session Notes (Unverified Agent Metadata)", ""];

  for (const note of notes) {
    lines.push(`### ${note.source}`);
    if (note.format === "json") {
      lines.push("```json");
    } else if (note.format === "markdown") {
      lines.push("```markdown");
    } else {
      lines.push("```text");
    }
    lines.push(note.body.length > 0 ? note.body : "_(empty note)_");
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function validateOutputPathOverride(format: OutputFormat, outPath: string | undefined): void {
  if (!outPath) {
    return;
  }

  if (format === "both") {
    throw new CliError("--out can only be used when --format is md or json.", ExitCode.ConfigError);
  }
}

function toGitChanges(diffResult: DiffResult): GitChange[] {
  const changes: GitChange[] = [];
  for (const entry of diffResult.added) {
    changes.push({ status: "A", filePath: entry.path });
  }
  for (const entry of diffResult.modified) {
    changes.push({ status: "M", filePath: entry.path });
  }
  for (const entry of diffResult.removed) {
    changes.push({ status: "D", filePath: entry.path });
  }
  return changes.sort((a, b) => {
    const byPath = a.filePath.localeCompare(b.filePath);
    if (byPath !== 0) return byPath;
    return a.status.localeCompare(b.status);
  });
}

function appendCommitSuggestions(
  markdown: string,
  groups: ReturnType<typeof CommitGrouper.groupChangesByDependency>,
  rootDir: string,
): string {
  const lines: string[] = [markdown.trimEnd(), "", "## Suggested Commits", ""];
  if (groups.length === 0) {
    lines.push("_No commit suggestions for this scan (no added/modified/removed tracked files)._");
    return lines.join("\n").trimEnd();
  }

  const condensedGroups = condenseCommitGroups(groups);
  const git = new GitService(rootDir);
  for (const group of condensedGroups) {
    const message = CommitGrouper.generateMessage(group);
    const command = git.renderCommitCommand(group.files, message);
    lines.push(`- \`${message}\``);
    lines.push(`  files: ${group.files.join(", ")}`);
    lines.push(`  cmd: \`${command}\``);
  }

  return lines.join("\n").trimEnd();
}

function condenseCommitGroups(groups: ReturnType<typeof CommitGrouper.groupChangesByDependency>): typeof groups {
  const groupedByScopeType = new Map<string, (typeof groups)[number]>();

  for (const group of groups) {
    const key = `${group.type}:${group.scope}`;
    const existing = groupedByScopeType.get(key);
    if (!existing) {
      groupedByScopeType.set(key, {
        ...group,
        files: [...group.files],
        changes: [...group.changes],
      });
      continue;
    }

    const mergedFiles = [...new Set([...existing.files, ...group.files])].sort((a, b) => a.localeCompare(b));
    const mergedChanges = [...existing.changes, ...group.changes].sort((a, b) => {
      const byPath = a.filePath.localeCompare(b.filePath);
      if (byPath !== 0) return byPath;
      return a.status.localeCompare(b.status);
    });

    groupedByScopeType.set(key, {
      ...existing,
      files: mergedFiles,
      changes: mergedChanges,
    });
  }

  return [...groupedByScopeType.values()].sort((a, b) => {
    if (a.files.length !== b.files.length) {
      return b.files.length - a.files.length;
    }
    return a.scope.localeCompare(b.scope);
  });
}
