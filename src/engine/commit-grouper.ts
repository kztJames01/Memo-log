import type { GitChange } from "./git.js";
import { categorizeFile, type Category } from "../types/categories.js";
import type { AstExtract } from "../types/scan.js";

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

const DEPENDENCY_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".rs", ".go"];

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

  static groupChangesByDependency(changes: GitChange[], extracts: AstExtract[]): CommitGroup[] {
    if (changes.length === 0) {
      return [];
    }

    const normalizedChanges = normalizeChanges(changes);
    const changedFilePaths = new Set(normalizedChanges.map((change) => change.filePath));
    const extractMap = new Map<string, AstExtract>();
    for (const extract of extracts) {
      extractMap.set(normalizeFilePath(extract.file), extract);
    }

    const adjacency = new Map<string, Set<string>>();
    for (const path of changedFilePaths) {
      adjacency.set(path, new Set<string>());
    }

    for (const path of changedFilePaths) {
      const extract = extractMap.get(path);
      if (!extract) {
        continue;
      }

      for (const dependency of resolveLocalDependencies(path, extract.imports)) {
        if (!changedFilePaths.has(dependency)) {
          continue;
        }
        adjacency.get(path)?.add(dependency);
        adjacency.get(dependency)?.add(path);
      }
    }

    const components = connectedComponents(changedFilePaths, adjacency);
    const groups = components.map((component) => {
      const componentChanges = normalizedChanges.filter((change) => component.has(change.filePath));
      const files = [...component].sort((a, b) => a.localeCompare(b));
      const scope = inferGroupScope(files);
      const type = inferConventionalType(scope, componentChanges);

      return {
        scope,
        files,
        changes: componentChanges.sort((a, b) => {
          const byPath = a.filePath.localeCompare(b.filePath);
          if (byPath !== 0) {
            return byPath;
          }
          return a.status.localeCompare(b.status);
        }),
        type,
      } satisfies CommitGroup;
    });

    return groups.sort((a, b) => {
      if (a.files.length !== b.files.length) {
        return b.files.length - a.files.length;
      }
      const byScope = scopePriority(a.scope) - scopePriority(b.scope);
      if (byScope !== 0) {
        return byScope;
      }
      return (a.files[0] ?? "").localeCompare(b.files[0] ?? "");
    });
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

function inferGroupScope(files: string[]): CommitScope {
  const score = new Map<CommitScope, number>();
  for (const filePath of files) {
    const scope = resolveScope(filePath);
    score.set(scope, (score.get(scope) ?? 0) + 1);
  }

  let bestScope: CommitScope = "utils";
  let bestScore = -1;
  for (const scope of SCOPE_ORDER) {
    const current = score.get(scope) ?? 0;
    if (current > bestScore) {
      bestScope = scope;
      bestScore = current;
    }
  }

  return bestScope;
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

function normalizeChanges(changes: GitChange[]): GitChange[] {
  const deduped = new Map<string, GitChange>();
  for (const change of changes) {
    const normalizedPath = normalizeFilePath(change.filePath);
    const dedupeKey = `${change.status}:${normalizedPath}`;
    if (!deduped.has(dedupeKey)) {
      deduped.set(dedupeKey, { ...change, filePath: normalizedPath });
    }
  }

  return [...deduped.values()].sort((a, b) => {
    const byPath = a.filePath.localeCompare(b.filePath);
    if (byPath !== 0) {
      return byPath;
    }
    return a.status.localeCompare(b.status);
  });
}

function connectedComponents(nodes: Set<string>, adjacency: Map<string, Set<string>>): Array<Set<string>> {
  const visited = new Set<string>();
  const components: Array<Set<string>> = [];

  for (const node of nodes) {
    if (visited.has(node)) {
      continue;
    }

    const component = new Set<string>();
    const queue: string[] = [node];
    visited.add(node);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      component.add(current);

      const neighbors = adjacency.get(current);
      if (!neighbors) {
        continue;
      }

      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) {
          continue;
        }
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    components.push(component);
  }

  return components;
}

function resolveLocalDependencies(filePath: string, imports: string[]): string[] {
  const dirParts = filePath.split("/");
  dirParts.pop();
  const currentDir = dirParts.join("/");

  const dependencies = new Set<string>();
  for (const imp of imports) {
    const target = normalizeImportPath(currentDir, imp);
    if (!target) {
      continue;
    }

    if (hasKnownExtension(target)) {
      dependencies.add(target);
      continue;
    }

    for (const ext of DEPENDENCY_EXTENSIONS) {
      dependencies.add(`${target}${ext}`);
      dependencies.add(`${target}/index${ext}`);
    }
  }

  return [...dependencies];
}

function normalizeImportPath(currentDir: string, importPath: string): string | null {
  if (importPath.startsWith("./") || importPath.startsWith("../")) {
    return normalizeRelativeSegments(currentDir, importPath.split("/"));
  }

  if (importPath.startsWith(".")) {
    const match = importPath.match(/^(\.+)(.*)$/);
    if (!match) {
      return null;
    }
    const dots = match[1] ?? "";
    const remainder = (match[2] ?? "").replace(/^\./, "");
    const upCount = Math.max(0, dots.length - 1);
    const upSegments = new Array(upCount).fill("..");
    const extraSegments = remainder.length > 0 ? remainder.split(".") : [];
    return normalizeRelativeSegments(currentDir, [...upSegments, ...extraSegments]);
  }

  return null;
}

function normalizeRelativeSegments(currentDir: string, rawSegments: string[]): string | null {
  const segments = currentDir.length > 0 ? currentDir.split("/") : [];
  for (const rawSegment of rawSegments) {
    const segment = rawSegment.trim();
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function hasKnownExtension(filePath: string): boolean {
  return DEPENDENCY_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}
