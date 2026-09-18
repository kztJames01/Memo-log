import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const EXPORT_CONTEXT_FILE = "MEMO_LOG_CONTEXT.json";

interface MemoryEntryLike {
  tech?: unknown;
  simple?: unknown;
  ref?: unknown;
  category?: unknown;
}

// stripped, reference-anchored json for pasting into an llm. no timestamps, no uuids.
export function buildExportContext(snapshot: unknown): Record<string, unknown> {
  const obj = snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>) : {};
  const rawEntries = Array.isArray(obj["entries"]) ? (obj["entries"] as MemoryEntryLike[]) : [];
  const entries = rawEntries
    .map((e) => ({
      ref: typeof e.ref === "string" ? e.ref : "",
      category: typeof e.category === "string" ? e.category : "",
      tech: typeof e.tech === "string" ? e.tech : "",
      simple: typeof e.simple === "string" ? e.simple : "",
    }))
    .filter((e) => e.ref.startsWith("[") && e.tech.length > 0)
    .sort((a, b) => a.ref.localeCompare(b.ref) || a.tech.localeCompare(b.tech));

  return {
    kind: "memo-log-export-context",
    schema: 1,
    note: "Deterministic facts only. Generate prose from these refs; do not invent files or line numbers.",
    entries,
  };
}

export function writeExportContext(targetDir: string, jsonPath?: string): string {
  const root = resolve(targetDir);
  const memoryJson = jsonPath ?? join(root, "MEMO_LOG.json");
  const raw = readFileSync(memoryJson, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const payload = buildExportContext(parsed);
  const outPath = join(root, EXPORT_CONTEXT_FILE);
  const tmp = join(dirname(outPath), `.tmp-ctx-${randomUUID()}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    renameSync(tmp, outPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  return outPath;
}
