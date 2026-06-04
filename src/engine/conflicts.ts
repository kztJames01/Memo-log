import { createHash } from "node:crypto";
import { z } from "zod";
import type { ParsedFile } from "../parsers/types.js";

export const ConflictSeverity = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  INFO: "INFO",
} as const;
export type ConflictSeverity = typeof ConflictSeverity[keyof typeof ConflictSeverity];

export interface ConflictEntry {
  exportName: string;
  filePath: string;
  severity: ConflictSeverity;
  agentARef: string;
  agentBRef: string;
  message: string;
}

export interface ConflictReport {
  scannedAt: string;
  totalConflicts: number;
  highCount: number;
  mediumCount: number;
  conflicts: ConflictEntry[];
  resolutionSuggestions: string[];
  hash: string;
}

export const ConflictEntrySchema = z.object({
  exportName: z.string().min(1),
  filePath: z.string().min(1),
  severity: z.enum(["HIGH", "MEDIUM", "INFO"]),
  agentARef: z.string(),
  agentBRef: z.string(),
  message: z.string(),
});

export const ConflictReportSchema = z.object({
  scannedAt: z.string().datetime(),
  totalConflicts: z.number().int().nonnegative(),
  highCount: z.number().int().nonnegative(),
  mediumCount: z.number().int().nonnegative(),
  conflicts: z.array(ConflictEntrySchema),
  resolutionSuggestions: z.array(z.string()),
  hash: z.string().regex(/^[a-f0-9]{64}$/, "hash must be SHA-256 hex"),
});

export type ConflictReportInput = Omit<ConflictReport, "hash">;

export interface ConflictDetectionOptions {
  scannedAt?: string;
}

export function detectConflicts(
  agentAFiles: ParsedFile[],
  agentBFiles: ParsedFile[],
  options: ConflictDetectionOptions = {},
): ConflictReport {
  const conflicts: ConflictEntry[] = [];
  const aMap = buildExportMap(agentAFiles);
  const bMap = buildExportMap(agentBFiles);
  const allPaths = new Set([...aMap.keys(), ...bMap.keys()]);

  for (const filePath of allPaths) {
    const aExports = aMap.get(filePath) ?? new Map();
    const bExports = bMap.get(filePath) ?? new Map();
    const allNames = new Set([...aExports.keys(), ...bExports.keys()]);

    for (const name of allNames) {
      const a = aExports.get(name);
      const b = bExports.get(name);
      if (a && !b) {
        conflicts.push({
          exportName: name,
          filePath,
          severity: ConflictSeverity.INFO,
          agentARef: `[${filePath}:${a.line}]`,
          agentBRef: "[missing]",
          message: `CONFLICT: export "${name}" exists in agent A but is missing in agent B`,
        });
        continue;
      }
      if (!a && b) {
        conflicts.push({
          exportName: name,
          filePath,
          severity: ConflictSeverity.INFO,
          agentARef: "[missing]",
          agentBRef: `[${filePath}:${b.line}]`,
          message: `CONFLICT: export "${name}" exists in agent B but is missing in agent A`,
        });
        continue;
      }
      if (!a || !b) continue;

      const aRef = `[${filePath}:${a.line}]`;
      const bRef = `[${filePath}:${b.line}]`;

      if (a.signature !== b.signature && a.signature && b.signature) {
        conflicts.push({
          exportName: name,
          filePath,
          severity: ConflictSeverity.HIGH,
          agentARef: aRef,
          agentBRef: bRef,
          message: `CONFLICT: export "${name}" has different signatures. A: "${a.signature}" vs B: "${b.signature}"`,
        });
      } else if (a.line !== b.line) {
        conflicts.push({
          exportName: name,
          filePath,
          severity: ConflictSeverity.MEDIUM,
          agentARef: aRef,
          agentBRef: bRef,
          message: `CONFLICT: export "${name}" moved from line ${a.line} (agent A) to line ${b.line} (agent B)`,
        });
      }
    }
  }

  conflicts.sort((a, b) => {
    const sevOrder = { HIGH: 0, MEDIUM: 1, INFO: 2 };
    const sv = sevOrder[a.severity] - sevOrder[b.severity];
    if (sv !== 0) return sv;
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    return a.exportName.localeCompare(b.exportName);
  });

  const suggestions = buildResolutionSuggestions(conflicts);
  const reportBody: ConflictReportInput = {
    scannedAt: options.scannedAt ?? new Date().toISOString(),
    totalConflicts: conflicts.length,
    highCount: conflicts.filter(c => c.severity === "HIGH").length,
    mediumCount: conflicts.filter(c => c.severity === "MEDIUM").length,
    conflicts,
    resolutionSuggestions: suggestions,
  };

  const hash = hashReport(reportBody);
  return { ...reportBody, hash };
}

function buildExportMap(files: ParsedFile[]): Map<string, Map<string, { line: number; signature: string | undefined }>> {
  const map = new Map<string, Map<string, { line: number; signature: string | undefined }>>();
  for (const file of files) {
    const exportMap = new Map<string, { line: number; signature: string | undefined }>();
    for (const exp of file.exports) {
      const sig = file.signatures.find(s => s.name === exp.name);
      exportMap.set(exp.name, { line: exp.line, signature: sig?.signature });
    }
    map.set(file.path, exportMap);
  }
  return map;
}

function buildResolutionSuggestions(conflicts: ConflictEntry[]): string[] {
  if (conflicts.length === 0) return [];
  const suggestions: string[] = [];
  const byFile = new Map<string, ConflictEntry[]>();
  for (const c of conflicts) {
    const existing = byFile.get(c.filePath) ?? [];
    existing.push(c);
    byFile.set(c.filePath, existing);
  }

  for (const [filePath, entries] of byFile) {
    const highCount = entries.filter(e => e.severity === "HIGH").length;
    if (highCount > 0) {
      suggestions.push(`Resolve ${highCount} signature conflict(s) in ${filePath} — coordinate with agents before merge.`);
    }
    const mediumCount = entries.filter(e => e.severity === "MEDIUM").length;
    if (mediumCount > 0) {
      suggestions.push(`Review ${mediumCount} line-number shift(s) in ${filePath} — likely safe to accept latest version.`);
    }
    const infoCount = entries.filter(e => e.severity === "INFO").length;
    if (infoCount > 0) {
      suggestions.push(`Review ${infoCount} add/remove export change(s) in ${filePath} before merging.`);
    }
  }
  suggestions.push("Suggestion: Review conflicts above and commit resolutions atomically per file using `git add <file> && git commit -m 'resolve: agent conflict in <file>'`.");
  return suggestions;
}

function hashReport(report: ConflictReportInput): string {
  // Deterministic hash over semantic payload (exclude scannedAt volatility).
  const hashInput = {
    totalConflicts: report.totalConflicts,
    highCount: report.highCount,
    mediumCount: report.mediumCount,
    conflicts: report.conflicts,
    resolutionSuggestions: report.resolutionSuggestions,
  };
  return createHash("sha256").update(JSON.stringify(hashInput), "utf8").digest("hex");
}

export function validateConflictReport(raw: unknown): ConflictReport {
  return ConflictReportSchema.parse(raw) as ConflictReport;
}

export function renderConflictMarkdown(report: ConflictReport): string {
  const lines: string[] = [
    "## Multi-Agent Conflict Report",
    `Generated: ${report.scannedAt}`,
    `Total conflicts: ${report.totalConflicts} (HIGH: ${report.highCount}, MEDIUM: ${report.mediumCount})`,
    `Report hash: ${report.hash}`,
    "",
  ];
  if (report.conflicts.length === 0) {
    lines.push("No conflicts detected.");
    return lines.join("\n");
  }
  for (const c of report.conflicts) {
    lines.push(`### [${c.severity}] ${c.exportName} in ${c.filePath}`);
    lines.push(c.message);
    lines.push(`- Agent A: ${c.agentARef}`);
    lines.push(`- Agent B: ${c.agentBRef}`);
    lines.push("");
  }
  if (report.resolutionSuggestions.length > 0) {
    lines.push("## Resolution Suggestions");
    for (const s of report.resolutionSuggestions) lines.push(`- ${s}`);
  }
  return lines.join("\n");
}
