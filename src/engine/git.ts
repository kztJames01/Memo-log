import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export type GitStatus = "A" | "M" | "D";
export interface GitChange {
  status: GitStatus;
  filePath: string;
}
export interface CommitResult {
  message: string;
  stdout: string;
  stderr: string;
}
const STATUS_PATTERN = /^(?<status>[ACDMRTUXB])\d*\s+/;
export function parseGitNameStatusOutput(output: string): GitChange[] {
  const changes: GitChange[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const match = line.match(STATUS_PATTERN);
    if (!match?.groups?.status) {
      continue;
    }

    const statusToken = match.groups.status;
    const payload = line.replace(STATUS_PATTERN, "").trim();
    if (!payload) {
      continue;
    }

    const fields = payload.includes("\t") ? payload.split("\t").filter(Boolean) : payload.split(/\s+/).filter(Boolean);
    const normalizedStatus = normalizeStatus(statusToken);
    const filePath = normalizeFilePath(fields[fields.length - 1] ?? payload);
    if (!filePath) {
      continue;
    }

    const dedupeKey = `${normalizedStatus}:${filePath}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    changes.push({ status: normalizedStatus, filePath });
  }

  return changes.sort((a, b) => {
    const byPath = a.filePath.localeCompare(b.filePath);
    if (byPath !== 0) {
      return byPath;
    }
    return a.status.localeCompare(b.status);
  });
}

export class GitService {
  private readonly cwd: string;

  constructor(rootDir: string) {
    this.cwd = path.resolve(rootDir);
  }

  async getChangedFiles(): Promise<GitChange[]> {
    const inRepo = await this.isInsideGitRepo();
    if (!inRepo) {
      return [];
    }

    const diffOutput = await this.runGit(["diff", "--stat", "--name-status", "HEAD"], true);
    const trackedChanges = parseGitNameStatusOutput(diffOutput.stdout);
    const untracked = await this.getUntrackedFiles();

    const merged = [...trackedChanges];
    const seen = new Set(merged.map((item) => `${item.status}:${item.filePath}`));
    for (const filePath of untracked) {
      const key = `A:${filePath}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ status: "A", filePath });
      }
    }

    return merged.sort((a, b) => {
      const byPath = a.filePath.localeCompare(b.filePath);
      if (byPath !== 0) {
        return byPath;
      }
      return a.status.localeCompare(b.status);
    });
  }

  async commitFiles(files: string[], message: string): Promise<CommitResult> {
    if (files.length === 0) {
      throw new Error("No files provided for commit.");
    }

    const uniqueFiles = [...new Set(files.map(sanitizeGitFilePath).filter(Boolean))];
    if (uniqueFiles.length === 0) {
      throw new Error("No valid files provided for commit.");
    }

    // Prefix with "./" to ensure git never interprets a path as a flag
    const safePrefixedFiles = uniqueFiles.map(prefixRelativePath);
    await this.runGit(["add", "-A", "--", ...safePrefixedFiles], false);
    const commitResult = await this.runGit(["commit", "-m", message], false);
    return {
      message,
      stdout: commitResult.stdout,
      stderr: commitResult.stderr,
    };
  }

  renderCommitCommand(files: string[], message: string): string {
    const safeFiles = [...new Set(files.map(sanitizeGitFilePath).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
      .map((f) => quoteShellArg(prefixRelativePath(f)));
    const safeMessage = quoteShellArg(message);
    return `git add -A -- ${safeFiles.join(" ")} && git commit -m ${safeMessage}`;
  }

  private async isInsideGitRepo(): Promise<boolean> {
    const result = await this.runGit(["rev-parse", "--is-inside-work-tree"], true);
    return result.stdout.trim() === "true";
  }

  private async getUntrackedFiles(): Promise<string[]> {
    const result = await this.runGit(["ls-files", "--others", "--exclude-standard"], true);
    if (!result.stdout.trim()) {
      return [];
    }

    return result.stdout
      .split("\n")
      .map((line) => normalizeFilePath(line.trim()))
      .filter((line): line is string => line.length > 0)
      .sort((a, b) => a.localeCompare(b));
  }

  private async runGit(args: string[], allowFailure: boolean): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, { cwd: this.cwd, encoding: "utf8" });
      return { stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (error) {
      if (allowFailure) {
        return { stdout: "", stderr: "" };
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Git command failed: git ${args.join(" ")} (${message})`);
    }
  }
}

function normalizeStatus(statusToken: string): GitStatus {
  if (statusToken === "A") return "A";
  if (statusToken === "D") return "D";
  return "M";
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").trim();
}

// Reject file paths that could be interpreted as git options.
// A path starting with "-" could inject flags into git subcommands.
function sanitizeGitFilePath(filePath: string): string {
  const normalized = normalizeFilePath(filePath);
  if (normalized.startsWith("-")) {
    throw new Error(`Invalid file path: "${filePath}" — paths must not start with "-"`);
  }
  return normalized;
}

// Prefix relative paths with "./" so git never treats them as flags,
// even if someone bypasses the sanitize check. Absolute paths are left as-is.
function prefixRelativePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  if (filePath.startsWith("./")) return filePath;
  return `./${filePath}`;
}

function quoteShellArg(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  // Reject control characters that can break shell quoting
  if (/[\x00-\x1f]/.test(value)) {
    throw new Error(`Unsafe shell argument: contains control characters`);
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
