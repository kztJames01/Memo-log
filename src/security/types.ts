export const DEFAULT_EXCLUDES = Object.freeze([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".ai-memory"
]);

export const DEFAULT_MAX_DEPTH = 64;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

export interface DirectoryWalkerOptions {
  rootPath: string;
  excludes?: string[] | undefined;
  maxDepth?: number | undefined;
  timeoutMs?: number | undefined;
  maxFileSizeBytes?: number | undefined;
}

export type TraversalWarningCode =
  | "SKIPPED_LARGE_FILE"
  | "TIMEOUT"
  | "PARSE_ISSUE"
  | "SYMLINK_ESCAPE"
  | "FS_ERROR"
  | "PATH_TRAVERSAL"
  | "PERMISSION_DENIED";

export interface TraversalWarning {
  code: TraversalWarningCode;
  message: string;
  relativePath?: string | undefined;
}

export interface ManifestFileEntry {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
}

export interface ScanManifest {
  rootPath: string;
  files: string[];
  entries: ManifestFileEntry[];
  warnings: string[];
  structuredWarnings: TraversalWarning[];
  timedOut: boolean;
  elapsedMs: number;
}
