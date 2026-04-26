//cache sytem for incremental scanning, using SHA-256 hash-based invalidation and a TTL-free design. This module provides functions to load, save, and manage cache entries for scanned files, as well as calibration data to optimize performance over time.
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const CACHE_DIR = ".ai-memory";
export const CACHE_FILE = join(CACHE_DIR, "cache.json");

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
//normalize path to lowercase POSIX for case-insensitive FS compatibility
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}
//hash content with normalized line endings for deterministic caching
export function hashContent(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

export function loadCache(): ProjectCache | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const raw = readFileSync(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.schemaVersion === 2 ? parsed : null;
  } catch {
    return null;
  }
}

//save cache atomically to prevent corruption, with fallback for environments without fs.rename support
export function saveCache(cache: ProjectCache): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const tempPath = join(CACHE_DIR, `.cache-${Date.now()}.tmp`);
  writeFileSync(tempPath, JSON.stringify(cache, null, 2), "utf8");
  
  // Atomic rename
  try {
    renameSync(tempPath, CACHE_FILE);
  } catch {
    // Fallback: direct write if rename fails
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
  }
}

//check if file has changed by comparing content hash with cache entry
export function hasFileChanged(
  filePath: string,
  content: string,
  cached: CacheEntry | undefined
): boolean {
  if (!cached) return true;
  
  const currentHash = hashContent(content);
  return currentHash !== cached.hash;
}

//update calibration data based on recent scan performance, adjusting concurrency for optimal throughput
export function updateCalibration(
  cache: ProjectCache,
  totalParseMs: number,
  fileCount: number,
  concurrency: number
): void {
  const avgParseMs = fileCount > 0 ? totalParseMs / fileCount : 0;
  
  // Auto-adjust concurrency if parsing is slow
  let newConcurrency = concurrency;
  if (avgParseMs > 5) {
    newConcurrency = Math.max(1, Math.floor(concurrency / 2));
  } else if (avgParseMs < 2) {
    newConcurrency = Math.min(concurrency + 1, cpus().length);
  }
  
  cache.calibration = {
    avgParseMs,
    concurrency: newConcurrency,
    lastCalibrated: new Date().toISOString()
  };
}
//get cache entry for a file, if it exists
export function getCacheEntry(
  cache: ProjectCache,
  normalizedPath: string
): CacheEntry | undefined {
  return cache.files[normalizedPath];
}

//set cache entry for a file after scanning
export function createEmptyCache(): ProjectCache {
  const cpuCount = cpus().length;
  return {
    schemaVersion: 2,
    lastScan: new Date().toISOString(),
    calibration: {
      avgParseMs: 0,
      concurrency: Math.max(2, cpuCount - 1),
      lastCalibrated: new Date().toISOString()
    },
    files: {}
  };
}

//clear cache --force
export function clearCache(): void {
  if (existsSync(CACHE_FILE)) {
    try {
      unlinkSync(CACHE_FILE);
    } catch {
      // File may not exist or be locked
    }
  }
}
