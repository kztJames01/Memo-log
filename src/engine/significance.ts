import type { ExportKind } from "../parsers/types.js";

export type SignificanceLevel = "high" | "medium" | "low";

export interface SignificanceOptions {
  filter: "trivial" | "logic" | "all";
  trackTypes: boolean;
}

const DEFAULT_OPTIONS: SignificanceOptions = {
  filter: "logic",
  trackTypes: false,
};

const HIGH_KINDS: readonly ExportKind[] = ["function", "class"];
const LOW_KINDS: readonly ExportKind[] = ["type"];

const CORE_DIR_PATTERNS = [
  "src/engine/",
  "src/cli/",
  "src/parsers/",
  "src/security/",
  "src/output/",
];

const CONFIG_NOISE_NAMES = [
  "Config",
  "Options",
  "Schema",
  "Type",
  "Props",
  "State",
  "Input",
  "Output",
  "Result",
];

function isCorePath(filePath: string): boolean {
  return CORE_DIR_PATTERNS.some((p) => filePath.includes(p));
}

function isConfigNoiseName(name: string): boolean {
  return CONFIG_NOISE_NAMES.some((exc) => name.includes(exc));
}

export function scoreExport(
  exp: { kind: ExportKind; name: string; line: number; column?: number },
  filePath: string,
  _options?: Partial<SignificanceOptions>,
): SignificanceLevel {
  const opts = { ...DEFAULT_OPTIONS, ..._options };

  if (opts.filter === "all") return "high";
  if (opts.filter === "trivial") return "high";

  const kind = exp.kind;

  if (HIGH_KINDS.includes(kind as ExportKind)) return "high";

  if (!opts.trackTypes && LOW_KINDS.includes(kind as ExportKind)) return "low";

  const inCorePath = isCorePath(filePath);
  const isNoise = isConfigNoiseName(exp.name);

  if (inCorePath && !isNoise) return "medium";
  if (inCorePath && isNoise) return "low";

  if (kind === "const" && /^[A-Z_]+$/.test(exp.name)) return "medium";

  return "low";
}

export function shouldTrackExport(
  exp: { kind: ExportKind; name: string; line: number; column?: number },
  filePath: string,
  options?: Partial<SignificanceOptions>,
): boolean {
  const score = scoreExport(exp, filePath, options);
  return score !== "low";
}

export function shouldTrackFile(
  exports: Array<{ kind: ExportKind; name: string; line: number; column?: number }>,
  filePath: string,
  options?: Partial<SignificanceOptions>,
): boolean {
  for (const exp of exports) {
    if (shouldTrackExport(exp, filePath, options)) return true;
  }
  return false;
}

export function filterExports<T extends { kind: ExportKind; name: string; line: number; column?: number }>(
  exports: T[],
  filePath: string,
  options?: Partial<SignificanceOptions>,
): { tracked: T[]; skipped: number } {
  const tracked: T[] = [];
  let skipped = 0;

  for (const exp of exports) {
    if (shouldTrackExport(exp, filePath, options)) {
      tracked.push(exp);
    } else {
      skipped++;
    }
  }

  return { tracked, skipped };
}
