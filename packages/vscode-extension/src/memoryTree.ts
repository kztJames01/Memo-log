import * as vscode from "vscode";

interface MemoryTreeItem {
  label: string;
  desc?: string;
}

export class MemoryTreeProvider implements vscode.TreeDataProvider<MemoryTreeItem>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: MemoryTreeItem): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.desc;
    item.command = { command: "memo-log.openMemory", title: "Open AI Memory" };
    return item;
  }

  async getChildren(): Promise<MemoryTreeItem[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return [{ label: "No workspace open" }];
    }
    const mdUri = vscode.Uri.joinPath(folders[0]!.uri, "MEMO_LOG.md");
    const jsonUri = vscode.Uri.joinPath(folders[0]!.uri, "MEMO_LOG.json");
    try {
      await vscode.workspace.fs.stat(mdUri);
    } catch {
      return [{ label: "MEMO_LOG.md missing", desc: "run scan" }];
    }
    let extra = "";
    try {
      const buf = await vscode.workspace.fs.readFile(jsonUri);
      const parsed = JSON.parse(new TextDecoder("utf-8").decode(buf)) as { metadata?: { totalFiles?: number }; warnings?: unknown[] };
      const files = parsed.metadata?.totalFiles ?? 0;
      const warns = Array.isArray(parsed.warnings) ? parsed.warnings.length : 0;
      extra = `${files} files` + (warns ? ` · ${warns} warn` : "");
    } catch {
      extra = "md only";
    }
    return [{ label: "AI Memory", desc: extra }];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
