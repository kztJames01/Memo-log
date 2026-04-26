// runs the end-to-end scan pipeline and writes deterministic outputs.
import fs from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { generateDualOutput, renderBriefMode, renderMarkdown } from "../output/dual-generator.js";
import { parseFile } from "../parsers/index.js";
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
  getDiffSummary
} from "./diff.js";

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
const DEFAULT_SCAN_EXCLUDES = ["node_modules", ".git", "dist", "build", "coverage", "AI_MEMORY.*"] as const;
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
  const scanDetails = await runStructuralScanWithDetails(rootDir, {
    timeoutMs: input.timeoutMs,
    maxDepth: input.maxDepth ?? config.maxDepth,
    maxFileSizeBytes: input.maxFileSizeBytes,
    excludes: runtimeExcludes,
  });

  const outputMode = mode === "brief" ? "simple" : mode;
  const snapshot = generateDualOutput(scanDetails.extracts, outputMode, rootDir);

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

  const markdownWithNotes = agentNotes.length > 0
    ? appendSessionNotes(markdownWithChanges, agentNotes)
    : markdownWithChanges;

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
    await writeFileAtomic(markdownPath, `${markdownWithNotes}\n`);
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
): Promise<AstExtract[]> {
  const details = await runStructuralScanWithDetails(targetDir, options);
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
): Promise<StructuralScanDetails> {
  const resolvedTargetDir = path.resolve(targetDir);
  try {
    accessSync(resolvedTargetDir, constants.R_OK);
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
        const parsed = await parseFile(filePath, result.value.content, result.value.size);
        for (const parseWarning of parsed.warnings) {
          warningLimiter.emit(warnings, parseWarning);
        }

        if (parsed.exports.length === 0) {
          continue;
        }

        const relativeFilePath = normalizeRelativePath(path.relative(manifest.rootPath, filePath));
        extracts.push({
          file: relativeFilePath,
          exports: parsed.exports.map((exp) => ({
            name: exp.name,
            line: exp.line,
            column: exp.column,
          })),
          imports: parsed.imports.map((imp) => imp.path),
          signatures: parsed.signatures.map((sig) => sig.signature),
        });
      } catch (error) {
        warningLimiter.emit(
          warnings,
          `WARN: Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  warningLimiter.flush(warnings);
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
  const tempFilePath = path.join(path.dirname(filePath), `.ai-memory-${randomUUID()}.tmp`);
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
      accessSync(absolutePath, constants.R_OK);
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
