import { createHash } from "crypto";
import {
  MemoryEntrySchema,
  MemorySnapshotSchema,
  type EntryCategory,
  createFileRef,
} from "../engine/anti-hallucination.js";
import type { MemorySnapshot } from "../engine/anti-hallucination.js";
import {
  categorizeFile,
  getRegistryEntry,
  CATEGORY_EMOJI,
} from "../types/categories.js";
import type { AstExtract } from "../types/scan.js";
import { WarningLimiter } from "../security/safeRead.js";

export type Mode = "tech" | "simple" | "dual";
const DETERMINISTIC_GENERATED_AT = "1970-01-01T00:00:00.000Z";

function humanizeExportName(name: string): string {
  const cleanName = name
    .replace(/^(get|set|is|has|should|handle|on|use)/, "")
    .replace(/^./, (c) => c.toLowerCase());

  return cleanName.replace(/([A-Z])/g, " $1").trim().toLowerCase();
}

export function generateDualOutput(
  astExtracts: AstExtract[],
  _mode: Mode,
  targetDir = process.cwd(),
): MemorySnapshot {
  const entries: ReturnType<typeof MemoryEntrySchema.parse>[] = [];
  const warnings: string[] = [];
  const warningLimiter = new WarningLimiter();
  const processedFiles = new Set<string>();
  let totalModules = 0;

  const orderedExtracts = [...astExtracts].sort((a, b) => a.file.localeCompare(b.file));

  for (const extract of orderedExtracts) {
    processedFiles.add(extract.file);
    totalModules += extract.exports.length;

    const cat = categorizeFile(extract.file) as EntryCategory;
    const registry = getRegistryEntry(extract.file);

    const orderedExports = [...extract.exports].sort((a, b) => {
      if (a.line !== b.line) return a.line - b.line;
      if ((a.column ?? 0) !== (b.column ?? 0)) return (a.column ?? 0) - (b.column ?? 0);
      return a.name.localeCompare(b.name);
    });

    for (const exp of orderedExports) {
      if (exp.name.startsWith("_")) continue;
      if (exp.name.length < 2) continue;

      const humanized = humanizeExportName(exp.name);
      const ref = createFileRef(extract.file, exp.line, exp.column);

      let techLabel: string;
      if (registry) {
        techLabel = `${registry.tech}: \`${exp.name}\``;
      } else if (exp.name[0] === exp.name[0]?.toUpperCase()) {
        techLabel = `Class/Component: \`${exp.name}\``;
      } else if (exp.name.startsWith("use")) {
        techLabel = `React hook: \`${exp.name}\``;
      } else if (exp.name.includes("Handler") || exp.name.startsWith("handle")) {
        techLabel = `Event handler: \`${exp.name}\``;
      } else {
        techLabel = `Module export: \`${exp.name}\``;
      }

      let simpleLabel: string;
      if (registry) {
        simpleLabel = `${registry.simple}: ${humanized}`;
      } else if (exp.name[0] === exp.name[0]?.toUpperCase()) {
        simpleLabel = `UI component or data structure: ${humanized}`;
      } else if (exp.name.startsWith("is") || exp.name.startsWith("has")) {
        simpleLabel = `Check if ${humanized}`;
      } else if (exp.name.startsWith("get")) {
        simpleLabel = `Retrieve ${humanized}`;
      } else if (exp.name.startsWith("set")) {
        simpleLabel = `Update ${humanized}`;
      } else if (exp.name.startsWith("handle")) {
        simpleLabel = `Process ${humanized}`;
      } else {
        simpleLabel = `Handles ${humanized} logic`;
      }

      try {
        const entry = MemoryEntrySchema.parse({
          id: createDeterministicEntryId(extract.file, exp.name, exp.line, exp.column),
          tech: techLabel,
          simple: simpleLabel,
          ref,
          category: cat,
        });
        entries.push(entry);
      } catch (error) {
        warningLimiter.emit(
          warnings,
          `WARN: Failed to create entry for ${exp.name} in ${extract.file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  warningLimiter.flush(warnings);

  const snapshot = {
    version: 2 as const,
    generatedAt: DETERMINISTIC_GENERATED_AT,
    targetDir,
    entries,
    warnings,
    metadata: {
      totalFiles: processedFiles.size,
      totalModules,
      languages: [...new Set(astExtracts.map(e => e.file.split(".").pop()).filter(Boolean))].sort(),
    },
  };

  return MemorySnapshotSchema.parse(snapshot);
}

export function renderMarkdown(data: MemorySnapshot, mode: Mode): string {
  const showTech = mode !== "simple";
  const showSimple = mode !== "tech";

  const lines: string[] = [];

  lines.push("# AI Memory Snapshot");
  lines.push("");
  lines.push(`_Last generated: ${data.generatedAt}_`);
  lines.push("");

  lines.push("## Impact Summary");
  lines.push(`- **Files analyzed:** ${data.metadata?.totalFiles ?? 0}`);
  lines.push(`- **Modules documented:** ${data.metadata?.totalModules ?? 0}`);
  lines.push(`- **Languages detected:** ${(data.metadata?.languages ?? []).join(", ") || "N/A"}`);
  lines.push("");

  if (showSimple) {
    lines.push("## Executive Brief (Non-Technical)");
    lines.push("");

    const nonTestEntries = data.entries.filter((e) => e.category !== "test");

    if (nonTestEntries.length === 0) {
      lines.push("_No significant user-facing features detected._");
    } else {
      const byCategory = groupByCategory(nonTestEntries);
      for (const [category, catEntries] of byCategory) {
        const emoji = CATEGORY_EMOJI[category] ?? "\u{1F4E6}";
        lines.push(`### ${emoji} ${humanizeCategory(category)}`);
        for (const entry of catEntries.slice(0, 20)) {
          lines.push(`- ${entry.simple} ${entry.ref}`);
        }
        if (catEntries.length > 20) {
          lines.push(`- _... and ${catEntries.length - 20} more_`);
        }
        lines.push("");
      }
    }
    lines.push("");
  }

  if (showTech) {
    lines.push("## Engineering Ledger (Technical)");
    lines.push("");

    if (data.entries.length === 0) {
      lines.push("_No parseable modules found._");
    } else {
      const byCategory = groupByCategory(data.entries);
      for (const [category, catEntries] of byCategory) {
        const emoji = CATEGORY_EMOJI[category] ?? "\u{1F4E6}";
        lines.push(`### ${emoji} ${category.toUpperCase()} (${catEntries.length})`);
        for (const entry of catEntries) {
          lines.push(`- ${entry.tech} ${entry.ref}`);
        }
        lines.push("");
      }
    }
    lines.push("");
  }

  if (data.warnings.length > 0) {
    lines.push("## Parser Notes");
    for (const warning of data.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("*Generated deterministically. Zero LLM calls. Every reference verified.*");
  lines.push(`*Schema version: ${data.version}*`);

  return lines.join("\n");
}

function groupByCategory(entries: MemorySnapshot["entries"]): Map<EntryCategory, typeof entries> {
  const grouped = new Map<EntryCategory, typeof entries>();
  for (const entry of entries) {
    const existing = grouped.get(entry.category) ?? [];
    existing.push(entry);
    grouped.set(entry.category, existing);
  }
  return grouped;
}

function humanizeCategory(category: EntryCategory): string {
  const nameMap: Record<EntryCategory, string> = {
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

export function renderBriefMode(data: MemorySnapshot): string {
  const lines: string[] = [];

  lines.push("# Project Brief");
  lines.push("");
  lines.push(`_Generated: ${data.generatedAt}_`);
  lines.push("");

  const nonTestEntries = data.entries.filter((e) => e.category !== "test");
  const authCount = nonTestEntries.filter((e) => e.category === "auth").length;
  const apiCount = nonTestEntries.filter((e) => e.category === "api").length;
  const componentCount = nonTestEntries.filter((e) => e.category === "components").length;

  lines.push("## Summary");
  lines.push(`- **Total features:** ${nonTestEntries.length}`);
  if (authCount > 0) lines.push(`- **Auth flows:** ${authCount} updated`);
  if (apiCount > 0) lines.push(`- **API endpoints:** ${apiCount} touched`);
  if (componentCount > 0) lines.push(`- **UI components:** ${componentCount} modified`);
  lines.push("");

  lines.push("## What's Changed (Plain English)");
  if (nonTestEntries.length === 0) {
    lines.push("_No user-facing changes detected._");
  } else {
    for (const entry of nonTestEntries) {
      lines.push(`- ${entry.simple} ${entry.ref}`);
    }
  }
  lines.push("");

  lines.push("---");
  lines.push("*Zero technical jargon. Ready for stakeholder review.*");

  return lines.join("\n");
}

function createDeterministicEntryId(
  filePath: string,
  exportName: string,
  line: number,
  column?: number,
): string {
  const hash = createHash("sha256")
    .update(`${filePath}:${exportName}:${line}:${column ?? 0}`)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
