export {
  walkDirectory,
  type DirectoryWalkerOptions,
  type ScanManifest,
  type TraversalWarning
} from "./walker.js";
export {
  assertPathWithinRoot,
  isPathWithinRoot,
  normalizeRelativePath,
  resolveSecureRoot,
  SecurityPathError,
  toContainedRelativePath
} from "./pathGuards.js";
export {
  DEFAULT_EXCLUDES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_TIMEOUT_MS
} from "./types.js";
export {
  safeReadFile,
  WarningLimiter,
  buildManifestSizeMap,
  type SafeReadResult
} from "./safeRead.js";
