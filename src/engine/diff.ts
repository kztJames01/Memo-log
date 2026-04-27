import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AstExtract } from "../types/scan.js";
import { categorizeFile, CATEGORY_PRIORITY, type Category } from "../types/categories.js";
import type { MemorySnapshot } from "./anti-hallucination.js";

export const STATE_DIR = ".ai-memory";

export type ChangeType = "ADDED" | "MODIFIED" | "REMOVED" | "UNTOUCHED";

export interface FileState {
  hash: string;
  fingerprint: string;
}

export interface StateV2 {
  version: 2;
  lastRun: string;
  files: Record<string, FileState>;
}

export interface FileDiff {
  path: string;
  changeType: ChangeType;
  category: Category;
  previousState: FileState | undefined;
  currentState: FileState | undefined;
}

export interface DiffResult {
  changes: FileDiff[];
  added: FileDiff[];
  modified: FileDiff[];
  removed: FileDiff[];
  untouched: FileDiff[];
  byCategory: Map<Category, FileDiff[]>;
}

// Normalize path to POSIX separators only — preserves case to avoid
// collisions on case-sensitive filesystems (Linux, macOS APFS case-sensitive).
// Previously used .toLowerCase() which caused Foo.ts and foo.ts to collide.
function normalizePathForState(p: string): string {
  return p.replace(/\\/g, "/");
}

function computeContentHash(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}
// fingerprint captures structure changes even when file size stays similar.
function computeFingerprint(extract: AstExtract): string {
  const exportNames = extract.exports.map((e) => e.name).sort().join(",");
  const importPaths = extract.imports.slice().sort().join(",");
  const signatureCount = extract.signatures.length;
  return createHash("sha256")
    .update(`${exportNames}|${importPaths}|${signatureCount}`)
    .digest("hex")
    .substring(0, 16);
}

export function loadState(rootDir: string): StateV2 | null {
  const stateFile = join(rootDir, STATE_DIR, "state.json");
  if (!existsSync(stateFile)) {
    return null;
  }
  try {
    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version === 2 && typeof parsed.lastRun === "string" && typeof parsed.files === "object") {
      return parsed as StateV2;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveState(state: StateV2, rootDir: string): void {
  atomicWriteJsonSync(join(rootDir, STATE_DIR), "state.json", state);
}

export function computeFileState(extract: AstExtract): FileState {
  return {
    hash: computeContentHash(JSON.stringify({ exports: extract.exports, signatures: extract.signatures })),
    fingerprint: computeFingerprint(extract),
  };
}

export function diffStates(
  currentExtracts: AstExtract[],
  previousState: StateV2 | null
): DiffResult {
  const currentMap = new Map<string, AstExtract>();
  for (const extract of currentExtracts) {
    const normalized = normalizePathForState(extract.file);
    currentMap.set(normalized, extract);
  }

  const previousFiles = previousState?.files ?? {};
  const previousPaths = new Set(Object.keys(previousFiles));

  const changes: FileDiff[] = [];
  const added: FileDiff[] = [];
  const modified: FileDiff[] = [];
  const removed: FileDiff[] = [];
  const untouched: FileDiff[] = [];

  for (const [path, extract] of currentMap) {
    const category = categorizeFile(path) as Category;
    const currentState = computeFileState(extract);

    if (!previousPaths.has(path)) {
      const diff: FileDiff = { path, changeType: "ADDED", category, previousState: undefined, currentState };
      changes.push(diff);
      added.push(diff);
    } else {
      const prev = previousFiles[path];
      if (!prev || prev.hash !== currentState.hash || prev.fingerprint !== currentState.fingerprint) {
        const diff: FileDiff = { path, changeType: "MODIFIED", category, previousState: prev, currentState };
        changes.push(diff);
        modified.push(diff);
      } else {
        const diff: FileDiff = { path, changeType: "UNTOUCHED", category, previousState: prev, currentState };
        changes.push(diff);
        untouched.push(diff);
      }
    }
  }

  for (const prevPath of previousPaths) {
    if (!currentMap.has(prevPath)) {
      const category = categorizeFile(prevPath) as Category;
      const diff: FileDiff = {
        path: prevPath,
        changeType: "REMOVED",
        category,
        previousState: previousFiles[prevPath],
        currentState: undefined,
      };
      changes.push(diff);
      removed.push(diff);
    }
  }

  const byCategory = new Map<Category, FileDiff[]>();
  for (const diff of changes) {
    const existing = byCategory.get(diff.category) ?? [];
    existing.push(diff);
    byCategory.set(diff.category, existing);
  }

  return { changes, added, modified, removed, untouched, byCategory };
}

export function buildCurrentState(extracts: AstExtract[]): StateV2 {
  const files: Record<string, FileState> = {};
  for (const extract of extracts) {
    const normalized = normalizePathForState(extract.file);
    files[normalized] = computeFileState(extract);
  }
  return {
    version: 2,
    lastRun: new Date().toISOString(),
    files,
  };
}

export function renderRecentChanges(diffResult: DiffResult): string {
  const lines: string[] = [];
  const hasChanges = diffResult.added.length > 0 || diffResult.modified.length > 0 || diffResult.removed.length > 0;

  if (!hasChanges) {
    return "";
  }

  lines.push("## 📅 Recent Changes");
  lines.push("");
  lines.push(`_Generated: ${new Date().toISOString()}_`);
  lines.push("");

  const sortedCategories = [...diffResult.byCategory.entries()].sort(
    (a, b) => CATEGORY_PRIORITY[b[0]] - CATEGORY_PRIORITY[a[0]]
  );

  for (const [category, diffs] of sortedCategories) {
    const added = diffs.filter((d) => d.changeType === "ADDED");
    const modified = diffs.filter((d) => d.changeType === "MODIFIED");
    const removed = diffs.filter((d) => d.changeType === "REMOVED");

    if (added.length === 0 && modified.length === 0 && removed.length === 0) {
      continue;
    }

    const emoji = getCategoryEmoji(category);
    lines.push(`### ${emoji} ${humanizeCategory(category)}`);

    for (const d of added) {
      lines.push(`- ➕ **Added:** \`${d.path}\` [new]`);
    }
    for (const d of modified) {
      lines.push(`- 🔄 **Modified:** \`${d.path}\` [changed]`);
    }
    for (const d of removed) {
      lines.push(`- ➖ **Removed:** \`${d.path}\` [deleted]`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  return lines.join("\n");
}

function getCategoryEmoji(category: Category): string {
  const emojiMap: Record<Category, string> = {
    auth: "\u{1F510}",
    api: "\u{1F310}",
    components: "\u{1F9E9}",
    utils: "\u{1F527}",
    config: "\u2699\u{FE0F}",
    test: "\u{1F9EA}",
    styles: "\u{1F3A8}",
    other: "\u{1F4E6}",
  };
  return emojiMap[category] ?? "\u{1F4E6}";
}

function humanizeCategory(category: Category): string {
  const nameMap: Record<Category, string> = {
    auth: "Authentication & Security",
    api: "API & Data Layer",
    components: "UI Components",
    utils: "Utilities & Helpers",
    config: "Configuration",
    test: "Testing & Quality",
    styles: "Styling & Design",
    other: "Other Modules",
  };
  return nameMap[category] ?? category;
}

export function appendRecentChanges(
  markdown: string,
  diffResult: DiffResult,
  _targetDir: string
): string {
  const recentChanges = renderRecentChanges(diffResult);
  if (!recentChanges) {
    return markdown;
  }

  const lines = markdown.split("\n");
  const insertIndex = findInsertIndex(lines);

  if (insertIndex === -1) {
    return markdown.trimEnd() + "\n\n" + recentChanges;
  }

  const before = lines.slice(0, insertIndex);
  const after = lines.slice(insertIndex);
  return [...before, recentChanges, ...after].join("\n");
}

function findInsertIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (line === "---" || line.startsWith("*Generated deterministically")) {
      return i;
    }
  }
  return -1;
}

export function validateNoStaleReferences(
  snapshot: MemorySnapshot,
  diffResult: DiffResult
): string[] {
  const violations: string[] = [];
  const removedPaths = new Set(diffResult.removed.map((d) => normalizePathForState(d.path)));

  for (const entry of snapshot.entries) {
    const refMatch = entry.ref.match(/^\[(.+?):\d+/);
    if (refMatch && refMatch[1] !== undefined) {
      const filePath = normalizePathForState(refMatch[1]);
      if (removedPaths.has(filePath)) {
        violations.push(`STALE_REF: Entry "${entry.id}" references removed file ${filePath}`);
      }
    }
  }

  return violations;
}

// Atomic file write using temp file + rename with collision-safe UUID names.
// Removed the non-atomic fallback that could corrupt state on crash.
export function writeStateAtomic(state: StateV2, rootDir: string): void {
  atomicWriteJsonSync(join(rootDir, STATE_DIR), "state.json", state);
}

export function clearState(rootDir: string): void {
  const stateFile = join(rootDir, STATE_DIR, "state.json");
  if (existsSync(stateFile)) {
    try {
      unlinkSync(stateFile);
    } catch {
      // ignore
    }
  }
}

export function getDiffSummary(diffResult: DiffResult): string {
  const parts: string[] = [];
  if (diffResult.added.length > 0) parts.push(`+${diffResult.added.length}`);
  if (diffResult.modified.length > 0) parts.push(`~${diffResult.modified.length}`);
  if (diffResult.removed.length > 0) parts.push(`-${diffResult.removed.length}`);
  return parts.length > 0 ? parts.join(" ") : "no changes";
}

// Shared atomic JSON write: writes to a UUID-named temp file, then renames.
// If rename fails (e.g. cross-device), throws rather than falling back to
// a non-atomic direct write that could corrupt on crash.
function atomicWriteJsonSync(dir: string, fileName: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  const targetFile = join(dir, fileName);
  const tempPath = join(dir, `.tmp-${randomUUID()}.json`);
  const serialized = JSON.stringify(data, null, 2);
  writeFileSync(tempPath, serialized, "utf8");
  try {
    renameSync(tempPath, targetFile);
  } catch {
    // Clean up temp file on rename failure, then throw
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw new Error(`Atomic write failed: could not rename temp file to ${targetFile}`);
  }
}
