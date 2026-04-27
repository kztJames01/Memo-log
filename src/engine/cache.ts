// Cache system for incremental scanning, using SHA-256 hash-based invalidation.
// All paths are resolved relative to rootDir to avoid writing to CWD.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";

export const CACHE_DIR = ".ai-memory";

export interface CacheEntry {
  hash: string;
  category: string;
  exports: string[];
  mtime: number;
  size: number;
}

export interface Calibration {
  avgParseMs: number;
  concurrency: number;
  lastCalibrated: string;
}

export interface ProjectCache {
  schemaVersion: 2;
  lastScan: string;
  calibration: Calibration;
  files: Record<string, CacheEntry>;
}

// Normalize path to POSIX separators (preserves case for correctness)
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

// Hash content with normalized line endings for deterministic caching
export function hashContent(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

// Load cache from the scan root directory instead of CWD
export function loadCache(rootDir: string): ProjectCache | null {
  const cacheFile = join(rootDir, CACHE_DIR, "cache.json");
  if (!existsSync(cacheFile)) return null;
  try {
    const raw = readFileSync(cacheFile, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.schemaVersion === 2 ? parsed : null;
  } catch {
    return null;
  }
}

// Save cache atomically to the scan root directory using UUID temp files
// to prevent collision under concurrent runs.
export function saveCache(cache: ProjectCache, rootDir: string): void {
  const cacheDir = join(rootDir, CACHE_DIR);
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, "cache.json");
  const tempPath = join(cacheDir, `.tmp-${randomUUID()}.json`);
  writeFileSync(tempPath, JSON.stringify(cache, null, 2), "utf8");
  try {
    renameSync(tempPath, cacheFile);
  } catch {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw new Error(`Atomic cache write failed: could not rename temp file to ${cacheFile}`);
  }
}

// Check if file has changed by comparing content hash with cache entry
export function hasFileChanged(
  filePath: string,
  content: string,
  cached: CacheEntry | undefined
): boolean {
  if (!cached) return true;

  const currentHash = hashContent(content);
  return currentHash !== cached.hash;
}

// Cache CPU count at module load to avoid repeated allocation
let _cpuCount: number | undefined;
function cpuCount(): number {
  if (_cpuCount === undefined) {
    try {
      _cpuCount = cpus().length;
    } catch {
      _cpuCount = 4;
    }
  }
  return _cpuCount;
}

// Update calibration data based on recent scan performance
export function updateCalibration(
  cache: ProjectCache,
  totalParseMs: number,
  fileCount: number,
  concurrency: number
): void {
  const avgParseMs = fileCount > 0 ? totalParseMs / fileCount : 0;

  let newConcurrency = concurrency;
  if (avgParseMs > 5) {
    newConcurrency = Math.max(1, Math.floor(concurrency / 2));
  } else if (avgParseMs < 2) {
    newConcurrency = Math.min(concurrency + 1, cpuCount());
  }

  cache.calibration = {
    avgParseMs,
    concurrency: newConcurrency,
    lastCalibrated: new Date().toISOString()
  };
}

// Get cache entry for a file, if it exists
export function getCacheEntry(
  cache: ProjectCache,
  normalizedPath: string
): CacheEntry | undefined {
  return cache.files[normalizedPath];
}

// Create an empty cache with sensible defaults
export function createEmptyCache(): ProjectCache {
  const cpuCores = cpuCount();
  return {
    schemaVersion: 2,
    lastScan: new Date().toISOString(),
    calibration: {
      avgParseMs: 0,
      concurrency: Math.max(2, cpuCores - 1),
      lastCalibrated: new Date().toISOString()
    },
    files: {}
  };
}

// Clear cache from the scan root directory
export function clearCache(rootDir: string): void {
  const cacheFile = join(rootDir, CACHE_DIR, "cache.json");
  if (existsSync(cacheFile)) {
    try {
      unlinkSync(cacheFile);
    } catch {
      // File may not exist or be locked
    }
  }
}
