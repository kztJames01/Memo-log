import * as path from "node:path";
import { z } from "zod";

export const AIMEMORY_CONFIG_FILE = ".aimemory.json";

export const AiMemoryModeSchema = z.enum(["tech", "simple", "dual", "brief"]);

const StringListSchema = z.array(z.string().trim().min(1));

const OutputPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !isMalformedOutputPath(value), {
    message: "Malformed output path",
  });

export const AiMemoryOutputSchema = z
  .object({
    markdown: OutputPathSchema,
    json: OutputPathSchema,
  })
  .strict();

export const AiMemoryConfigSchema = z
  .object({
    languages: StringListSchema,
    exclude: StringListSchema,
    output: AiMemoryOutputSchema,
    maxDepth: z.number().int().nonnegative(),
    mode: AiMemoryModeSchema,
  })
  .strict();

export const AiMemoryConfigOverridesSchema = z
  .object({
    languages: StringListSchema.optional(),
    exclude: StringListSchema.optional(),
    output: AiMemoryOutputSchema.partial().optional(),
    maxDepth: z.number().int().nonnegative().optional(),
    mode: AiMemoryModeSchema.optional(),
  })
  .strict();

export type AiMemoryMode = z.infer<typeof AiMemoryModeSchema>;
export type AiMemoryOutput = z.infer<typeof AiMemoryOutputSchema>;
export type AiMemoryConfig = z.infer<typeof AiMemoryConfigSchema>;
export type AiMemoryConfigOverrides = z.infer<
  typeof AiMemoryConfigOverridesSchema
>;

export const DEFAULT_AI_MEMORY_CONFIG: AiMemoryConfig = {
  languages: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
  exclude: [".git", "node_modules", "dist", "build", ".ai-memory"],
  output: {
    markdown: "AI_MEMORY.md",
    json: "AI_MEMORY.json",
  },
  maxDepth: 20,
  mode: "dual",
};

export function normalizeStringList(
  values: readonly string[],
  options: { lowercase?: boolean } = {},
): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    let normalized = value.trim();
    if (options.lowercase) {
      normalized = normalized.toLowerCase();
    }
    if (normalized.length > 0) {
      seen.add(normalized);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function normalizeExcludeList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = trimTrailingSeparators(value.trim());
    if (cleaned.length > 0) {
      seen.add(cleaned);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function normalizeOutputPath(rawPath: string, rootDir: string): string {
  const trimmed = rawPath.trim();
  if (isMalformedOutputPath(trimmed)) {
    throw new Error(`Malformed output path: ${rawPath}`);
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(resolvedRoot, trimmed);
  if (!isPathInsideRoot(resolvedRoot, resolvedPath)) {
    throw new Error(
      `Output path "${rawPath}" resolves outside scan root "${resolvedRoot}"`,
    );
  }

  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative === ".") {
    throw new Error(`Output path "${rawPath}" must point to a file`);
  }

  return toPosixPath(relative);
}

export function normalizeAiMemoryConfig(
  config: AiMemoryConfig,
  rootDir: string,
): AiMemoryConfig {
  return {
    languages: normalizeStringList(config.languages, { lowercase: true }),
    exclude: normalizeExcludeList(config.exclude),
    output: {
      markdown: normalizeOutputPath(config.output.markdown, rootDir),
      json: normalizeOutputPath(config.output.json, rootDir),
    },
    maxDepth: config.maxDepth,
    mode: config.mode,
  };
}

export function isMalformedOutputPath(input: string): boolean {
  if (input.length === 0) {
    return true;
  }

  if (/[\u0000-\u001F]/.test(input)) {
    return true;
  }

  if (/[\\/]\s*$/.test(input)) {
    return true;
  }

  const normalizedSeparators = input.replace(/\\/g, "/");
  const segments = normalizedSeparators.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return true;
  }

  return false;
}

function trimTrailingSeparators(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return value.replace(/[\\/]+$/g, "");
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}
