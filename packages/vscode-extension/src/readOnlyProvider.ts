import * as vscode from "vscode";
import { buildMemoryHtml } from "./securityUtils.js";

export class MemoryPanel implements vscode.Disposable {
  private currentPanel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  show(): void {
    if (this.currentPanel) {
      this.currentPanel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.currentPanel = vscode.window.createWebviewPanel(
      "memo-log.memoryView",
      "AI Memory",
      vscode.ViewColumn.Beside,
      {
        enableScripts: false,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    this.currentPanel.onDidDispose(() => {
      this.currentPanel = undefined;
    }, null, this.disposables);

    void this.loadContent();
  }

  refresh(): void {
    if (!this.currentPanel) return;
    void this.loadContent();
  }

  private async loadContent(): Promise<void> {
    if (!this.currentPanel) return;
    const content = await this.readMemoryFile();
    this.currentPanel.webview.html = buildMemoryHtml(content);
  }

  private async readMemoryFile(): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return "No workspace open.";
    }

    const mdUri = vscode.Uri.joinPath(workspaceFolders[0]!.uri, "MEMO_LOG.md");
    try {
      const buf = await vscode.workspace.fs.readFile(mdUri);
      const content = new TextDecoder("utf-8").decode(buf);
      if (content.length > 1_000_000) {
        return "MEMO_LOG.md exceeds 1MB display limit. Open file directly.";
      }
      return content;
    } catch {
      return "MEMO_LOG.md not found. Run `memo-log scan .` first.";
    }
  }

  dispose(): void {
    this.currentPanel?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
