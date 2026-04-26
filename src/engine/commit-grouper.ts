import type { GitChange } from "./git.js";
import { categorizeFile, type Category } from "../types/categories.js";

export type CommitScope =
  | "auth"
  | "api"
  | "components"
  | "utils"
  | "config"
  | "styles"
  | "test"
  | "chore";

export type ConventionalType = "feat" | "fix" | "refactor" | "style" | "test" | "chore";

export interface CommitGroup {
  scope: CommitScope;
  files: string[];
  changes: GitChange[];
  type: ConventionalType;
}

const SCOPE_ORDER: CommitScope[] = [
  "auth",
  "api",
  "components",
  "utils",
  "config",
  "styles",
  "test",
  "chore",
];

const CHORE_FILE_PATTERNS: RegExp[] = [
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^pnpm-lock\.ya?ml$/i,
  /^yarn\.lock$/i,
  /^bun\.lockb$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^eslint\.config\.[cm]?js$/i,
  /^vitest\.config\.[cm]?ts$/i,
  /^tsup\.config\.[cm]?ts$/i,
  /^\.npmrc$/i,
  /^\.nvmrc$/i,
];

export class CommitGrouper {
  static groupChanges(changes: GitChange[]): CommitGroup[] {
    const grouped = new Map<CommitScope, GitChange[]>();

    for (const change of changes) {
      const scope = resolveScope(change.filePath);
      const existing = grouped.get(scope) ?? [];
      existing.push(change);
      grouped.set(scope, existing);
    }

    return [...grouped.entries()]
      .map(([scope, scopeChanges]) => {
        const files = [...new Set(scopeChanges.map((change) => normalizeFilePath(change.filePath)))]
          .filter((filePath) => filePath.length > 0)
          .sort((a, b) => a.localeCompare(b));

        const sortedChanges = [...scopeChanges].sort((a, b) => {
          const byPath = a.filePath.localeCompare(b.filePath);
          if (byPath !== 0) {
            return byPath;
          }
          return a.status.localeCompare(b.status);
        });

        return {
          scope,
          files,
          changes: sortedChanges,
          type: inferConventionalType(scope, sortedChanges),
        } satisfies CommitGroup;
      })
      .sort((a, b) => scopePriority(a.scope) - scopePriority(b.scope));
  }

  static generateMessage(group: CommitGroup): string {
    const summary = summarizeScopeChange(group.scope, group.files.length);
    return `${group.type}(${group.scope}): ${summary}`;
  }
}

function resolveScope(filePath: string): CommitScope {
  const normalized = normalizeFilePath(filePath);
  const basename = normalized.split("/").pop() ?? normalized;
  if (isChoreFile(normalized, basename)) {
    return "chore";
  }

  const category = categorizeFile(normalized);
  return categoryToScope(category);
}

function categoryToScope(category: Category): CommitScope {
  if (category === "auth") return "auth";
  if (category === "api") return "api";
  if (category === "components") return "components";
  if (category === "utils") return "utils";
  if (category === "config") return "config";
  if (category === "styles") return "styles";
  if (category === "test") return "test";
  return "utils";
}
// treats repo/config/tooling files as chore scope.
function isChoreFile(normalizedPath: string, basename: string): boolean {
  if (normalizedPath.startsWith(".github/workflows/")) {
    return true;
  }
  if (normalizedPath.startsWith(".vscode/")) {
    return true;
  }
  return CHORE_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

function inferConventionalType(scope: CommitScope, changes: GitChange[]): ConventionalType {
  if (scope === "styles") return "style";
  if (scope === "test") return "test";
  if (scope === "chore") return "chore";

  const hasAdded = changes.some((change) => change.status === "A");
  const hasModified = changes.some((change) => change.status === "M");
  const hasDeleted = changes.some((change) => change.status === "D");

  if (hasAdded && !hasModified && !hasDeleted) return "feat";
  if (hasModified && !hasAdded && !hasDeleted) return "fix";
  if (hasDeleted && !hasAdded) return "refactor";
  if (hasAdded && hasModified && !hasDeleted) return "feat";
  return "refactor";
}

function summarizeScopeChange(scope: CommitScope, fileCount: number): string {
  const noun = scope === "components" ? "component" : scope;
  if (fileCount <= 1) {
    return `update ${noun} module`;
  }
  return `update ${noun} modules (${fileCount} files)`;
}

function scopePriority(scope: CommitScope): number {
  const idx = SCOPE_ORDER.indexOf(scope);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").trim();
}
