// hash-skip parse: reuse cache when content hash matches.
import { parseFile } from "../parsers/index.js";
import type { AstExtract } from "../types/scan.js";
import { categorizeFile } from "../types/categories.js";
import { filterExports, type SignificanceOptions } from "./significance.js";
import {
  getCacheEntry,
  buildCacheEntry,
  extractFromCacheEntry,
  hasFileChanged,
  normalizePath,
  type ProjectCache,
} from "./cache.js";

export interface CachedParseResult {
  extract: AstExtract | null;
  warnings: string[];
  fromCache: boolean;
  parseMs: number;
}

export async function resolveExtractForFile(
  absolutePath: string,
  relPath: string,
  content: string,
  fileSize: number,
  cache: ProjectCache,
  sigOptions?: SignificanceOptions,
): Promise<CachedParseResult> {
  const warnings: string[] = [];
  const normalizedPath = normalizePath(relPath);
  const cached = getCacheEntry(cache, normalizedPath);
  const start = Date.now();

  if (cached && !hasFileChanged(normalizedPath, content, cached)) {
    const fromCache = extractFromCacheEntry(relPath, cached);
    if (fromCache) {
      const { tracked } = filterExports(fromCache.exports, relPath, sigOptions);
      if (tracked.length === 0) {
        return { extract: null, warnings, fromCache: true, parseMs: Date.now() - start };
      }
      return {
        extract: {
          ...fromCache,
          exports: tracked,
        },
        warnings,
        fromCache: true,
        parseMs: Date.now() - start,
      };
    }
  }

  const parsed = await parseFile(absolutePath, content, fileSize);
  for (const w of parsed.warnings) {
    warnings.push(w);
  }

  if (parsed.exports.length === 0) {
    delete cache.files[normalizedPath];
    return { extract: null, warnings, fromCache: false, parseMs: Date.now() - start };
  }

  const mappedExports = parsed.exports.map((exp) => ({
    name: exp.name,
    line: exp.line,
    column: exp.column,
    kind: exp.kind,
  }));

  const { tracked } = filterExports(mappedExports, relPath, sigOptions);
  if (tracked.length === 0) {
    delete cache.files[normalizedPath];
    return { extract: null, warnings, fromCache: false, parseMs: Date.now() - start };
  }

  const imports = parsed.imports.map((imp) => imp.path);
  const signatures = parsed.signatures.map((sig) => sig.signature);

  const extract: AstExtract = {
    file: relPath,
    lang: parsed.lang,
    contentHash: parsed.contentHash,
    exports: tracked,
    imports,
    signatures,
  };

  const category = categorizeFile(relPath);
  cache.files[normalizedPath] = buildCacheEntry(
    mappedExports,
    imports,
    signatures,
    parsed.lang,
    parsed.contentHash,
    category,
    fileSize,
  );

  return { extract, warnings, fromCache: false, parseMs: Date.now() - start };
}

export function removeCacheEntry(cache: ProjectCache, relPath: string): void {
  const key = normalizePath(relPath);
  delete cache.files[key];
}
