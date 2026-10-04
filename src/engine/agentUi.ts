import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { STATE_DIR, loadState } from "./diff.js";
import { parseFile } from "../parsers/index.js";
import type { ParsedFile } from "../parsers/types.js";
import { detectConflicts, renderConflictMarkdown, type ConflictReport } from "./conflicts.js";
import { assertPathWithinRoot, normalizeRelativePath, resolveSecureRoot } from "../security/pathGuards.js";

interface SnapshotFileEntry {
  path: string;
  exports: ParsedFile["exports"];
  signatures: ParsedFile["signatures"];
}

interface AgentUiSnapshotV1 {
  version: 1;
  generatedAt: string;
  files: SnapshotFileEntry[];
}

export interface AgentUiWorkflowResult {
  previousSnapshotFound: boolean;
  report: ConflictReport | null;
  reportPath: string;
  snapshotPath: string;
  warnings: string[];
}

const AGENT_UI_SNAPSHOT_FILE = "agent-ui.snapshot.json";

function getSnapshotPath(rootDir: string): string {
  return path.join(rootDir, STATE_DIR, AGENT_UI_SNAPSHOT_FILE);
}

function getReportPath(rootDir: string): string {
  return path.join(rootDir, "MEMO_LOG_CONFLICTS.md");
}

async function loadSnapshot(rootDir: string): Promise<AgentUiSnapshotV1 | null> {
  const snapshotPath = getSnapshotPath(rootDir);
  if (!existsSync(snapshotPath)) return null;
  try {
    const raw = await readFile(snapshotPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentUiSnapshotV1>;
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) return null;
    return {
      version: 1,
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : new Date(0).toISOString(),
      files: parsed.files.filter((entry): entry is SnapshotFileEntry =>
        typeof entry?.path === "string" &&
        Array.isArray(entry?.exports) &&
        Array.isArray(entry?.signatures)
      ),
    };
  } catch {
    return null;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.tmp-${randomUUID()}`);
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function saveSnapshot(rootDir: string, files: ParsedFile[]): Promise<void> {
  const snapshot: AgentUiSnapshotV1 = {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: files
      .map((f) => ({
        path: f.path,
        exports: f.exports,
        signatures: f.signatures,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  await atomicWrite(getSnapshotPath(rootDir), `${JSON.stringify(snapshot, null, 2)}\n`);
}

function snapshotToParsedFiles(snapshot: AgentUiSnapshotV1): ParsedFile[] {
  return snapshot.files.map((entry) => ({
    path: entry.path,
    lang: undefined,
    contentHash: "",
    exports: entry.exports,
    imports: [],
    signatures: entry.signatures,
    usedFallback: false,
    warnings: [],
  }));
}

export interface CurrentStateParseResult {
  parsedFiles: ParsedFile[];
  totalStateFiles: number;
  stateAvailable: boolean;
  cappedStatePaths: string[];
  warnings: string[];
}

export async function buildCurrentParsedFilesFromState(
  rootDir: string,
  maxFiles = 100,
): Promise<CurrentStateParseResult> {
  const state = loadState(rootDir);
  const warnings: string[] = [];
  if (!state) {
    return { parsedFiles: [], totalStateFiles: 0, stateAvailable: false, cappedStatePaths: [], warnings };
  }

  // P0 fix: StateV2.files is Record<string, FileState>, not array.
  const totalStateFiles = Object.keys(state.files).length;
  const secureRoot = await resolveSecureRoot(rootDir);
  const relativePaths = Object.keys(state.files).sort().slice(0, maxFiles);
  const cappedStatePaths: string[] = [];
  const parsedFiles: ParsedFile[] = [];

  for (const rawRelativePath of relativePaths) {
    let relativePath = "";
    try {
      relativePath = normalizeRelativePath(rawRelativePath);
      if (!relativePath || relativePath.includes("..")) {
        warnings.push(`WARN: AGENT_UI_UNSAFE_STATE_PATH_SKIPPED — ${rawRelativePath}`);
        continue;
      }
    } catch {
      warnings.push(`WARN: AGENT_UI_UNSAFE_STATE_PATH_SKIPPED — ${rawRelativePath}`);
      continue;
    }

    const absolutePath = path.resolve(secureRoot, relativePath);
    try {
      assertPathWithinRoot(secureRoot, absolutePath);
      const content = await readFile(absolutePath, "utf8");
      const fileSize = Buffer.byteLength(content, "utf8");
      // Use normalized relative path so reports are stable and match state keys.
      const parsed = await parseFile(relativePath, content, fileSize);
      parsedFiles.push(parsed);
      cappedStatePaths.push(relativePath);
    } catch {
      // Skip deleted/unreadable files; scan state may be slightly stale.
      if (!warnings.some((entry) => entry.includes(rawRelativePath))) {
        warnings.push(`WARN: AGENT_UI_STATE_PATH_UNREADABLE_SKIPPED — ${rawRelativePath}`);
      }
    }
  }

  return { parsedFiles, totalStateFiles, stateAvailable: true, cappedStatePaths, warnings };
}

export async function runAgentUiWorkflow(
  rootDir: string,
): Promise<AgentUiWorkflowResult> {
  const previousSnapshot = await loadSnapshot(rootDir);
  const currentParse = await buildCurrentParsedFilesFromState(rootDir);
  const currentFiles = currentParse.parsedFiles;
  const reportPath = getReportPath(rootDir);
  const snapshotPath = getSnapshotPath(rootDir);
  const warnings: string[] = [];

  let report: ConflictReport | null = null;

  if (currentParse.stateAvailable && currentParse.totalStateFiles > 100) {
    const omitted = currentParse.totalStateFiles - 100;
    warnings.push(`WARN: AGENT_UI_FILE_CAP_APPLIED — omitted ${omitted} file(s) beyond first 100 state entries.`);
  }

  if (!currentParse.stateAvailable || currentParse.totalStateFiles === 0) {
    warnings.push("WARN: AGENT_UI_STATE_EMPTY — no current state files available for conflict detection.");
  }
  warnings.push(...currentParse.warnings);

  if (previousSnapshot) {
    if (currentFiles.length === 0) {
      warnings.push("WARN: AGENT_UI_CONFLICT_SKIPPED_EMPTY_CURRENT — comparison skipped because current parse set is empty.");
      const skippedMarkdown = [
        "## Multi-Agent Conflict Report",
        "Conflict detection skipped: current parse set is empty.",
        "See warnings in CLI output for details.",
      ].join("\n");
      await atomicWrite(reportPath, skippedMarkdown);
    } else {
      const cappedSet = new Set(currentParse.cappedStatePaths);
      const previousFiles = snapshotToParsedFiles(previousSnapshot).filter((entry) => cappedSet.has(entry.path));
      report = detectConflicts(previousFiles, currentFiles);
      const markdown = renderConflictMarkdown(report);
      await atomicWrite(reportPath, markdown);
    }
  }

  // P1 fix: Do not clobber existing snapshot with empty current parse set.
  if (currentFiles.length > 0) {
    await saveSnapshot(rootDir, currentFiles);
  } else if (previousSnapshot) {
    warnings.push("WARN: AGENT_UI_SNAPSHOT_PRESERVED — kept previous snapshot because current parse set is empty.");
  }

  return {
    previousSnapshotFound: previousSnapshot !== null,
    report,
    reportPath,
    snapshotPath,
    warnings,
  };
}
