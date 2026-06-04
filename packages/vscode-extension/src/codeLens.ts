import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { findNearbyEntries } from "./codelensUtils.js";

interface MemoryEntry {
  id: string;
  tech: string;
  simple: string;
  ref: string;
  category: string;
}

interface MemorySnapshot {
  version: number;
  generatedAt: string;
  targetDir: string;
  entries: MemoryEntry[];
}

// Shows [Memory] lens on exported functions/classes; hover shows tech/simple summary.
// Pre-computes summaries from cached MEMO_LOG.json so hover is <50ms.
export class MemoryCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private cachedSnapshot: MemorySnapshot | undefined;
  private cacheLoadedAt = 0;
  private readonly cacheTtlMs = 5000; // re-read file at most every 5s
  private disposables: vscode.Disposable[] = [];
  private changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Watch for MEMO_LOG.json changes and invalidate cache
    const watcher = vscode.workspace.createFileSystemWatcher("**/MEMO_LOG.json");
    watcher.onDidChange(() => {
      this.cachedSnapshot = undefined;
      this.changeEmitter.fire();
    });
    this.disposables.push(watcher);
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const snapshot = this.getSnapshot();
    if (!snapshot) return [];

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return [];

    const rootPath = workspaceFolders[0]!.uri.fsPath;
    // normalize file path to match ref format: relative, posix
    const relFile = path.relative(rootPath, document.uri.fsPath).replace(/\\/g, "/");

    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // Match export declarations
      if (!isExportLine(line)) continue;

      // Find entries referencing this file near this line
      const nearby = findNearbyEntries(snapshot.entries, relFile, i + 1);
      if (nearby.length === 0) continue;

      const range = new vscode.Range(i, 0, i, 0);
      const entry = nearby[0]!;

      lenses.push(new vscode.CodeLens(range, {
        title: `[Memory] ${truncate(entry.simple, 60)}`,
        command: "memo-log.showEntryDetail",
        arguments: [entry],
        tooltip: `Tech: ${entry.tech}\nSimple: ${entry.simple}\nRef: ${entry.ref}`,
      }));
    }

    return lenses;
  }

  resolveCodeLens(lens: vscode.CodeLens): vscode.CodeLens {
    return lens;
  }

  private getSnapshot(): MemorySnapshot | undefined {
    const now = Date.now();
    if (this.cachedSnapshot && now - this.cacheLoadedAt < this.cacheTtlMs) {
      return this.cachedSnapshot;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return undefined;

    const jsonPath = path.join(workspaceFolders[0]!.uri.fsPath, "MEMO_LOG.json");
    try {
      if (!fs.existsSync(jsonPath)) return undefined;
      const raw = fs.readFileSync(jsonPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isMemorySnapshot(parsed)) return undefined;
      this.cachedSnapshot = parsed;
      this.cacheLoadedAt = now;
      return this.cachedSnapshot;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.changeEmitter.dispose();
  }
}

function isExportLine(line: string): boolean {
  return /^\s*export\s+(default\s+)?(function|class|const|let|var|async\s+function|type|interface|enum)/.test(line)
    || /^\s*def\s+\w+/.test(line)   // python
    || /^\s*pub\s+(fn|struct|enum|trait)/.test(line)   // rust
    || /^\s*func\s+\w+/.test(line);  // go
}

function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.substring(0, len - 3) + "...";
}

function isMemorySnapshot(v: unknown): v is MemorySnapshot {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return obj["version"] === 2 && Array.isArray(obj["entries"]);
}
