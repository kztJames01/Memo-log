import * as vscode from "vscode";
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

export class MemoryCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private cachedSnapshot: MemorySnapshot | undefined;
  private cacheLoadedAt = 0;
  private readonly cacheTtlMs = 5000;
  private disposables: vscode.Disposable[] = [];
  private changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/MEMO_LOG.json");
    watcher.onDidChange(() => {
      this.cachedSnapshot = undefined;
      this.changeEmitter.fire();
    });
    this.disposables.push(watcher);
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const snapshot = await this.getSnapshot();
    if (!snapshot) return [];

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return [];

    const rootPath = workspaceFolders[0]!.uri.fsPath;
    const relFile = document.uri.fsPath
      .slice(rootPath.length)
      .replace(/^[\\/]/, "")
      .replace(/\\/g, "/");

    const lenses: vscode.CodeLens[] = [];
    const lines = document.getText().split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!isExportLine(line)) continue;

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

  private async getSnapshot(): Promise<MemorySnapshot | undefined> {
    const now = Date.now();
    if (this.cachedSnapshot && now - this.cacheLoadedAt < this.cacheTtlMs) {
      return this.cachedSnapshot;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return undefined;

    const jsonUri = vscode.Uri.joinPath(workspaceFolders[0]!.uri, "MEMO_LOG.json");
    try {
      const buf = await vscode.workspace.fs.readFile(jsonUri);
      const parsed = JSON.parse(new TextDecoder("utf-8").decode(buf)) as unknown;
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
    || /^\s*def\s+\w+/.test(line)
    || /^\s*pub\s+(fn|struct|enum|trait)/.test(line)
    || /^\s*func\s+\w+/.test(line);
}

function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.substring(0, len - 3) + "...";
}

function isMemorySnapshot(v: unknown): v is MemorySnapshot {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return obj["version"] === 2 && Array.isArray(obj["entries"]);
}
