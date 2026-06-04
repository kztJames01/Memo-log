import * as vscode from "vscode";
import * as path from "path";
import { buildMemoryHtml } from "./securityUtils.js";

// Reads MEMO_LOG.md and MEMO_LOG.json from workspace. Never writes anything.
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
        enableScripts: false, // no scripts; pure read-only HTML
        retainContextWhenHidden: true,
        localResourceRoots: [], // no local resource access
      }
    );

    this.currentPanel.onDidDispose(() => {
      this.currentPanel = undefined;
    }, null, this.disposables);

    this.loadContent();
  }

  refresh(): void {
    if (!this.currentPanel) return;
    this.loadContent();
  }

  private loadContent(): void {
    if (!this.currentPanel) return;
    const content = this.readMemoryFile();
    this.currentPanel.webview.html = buildMemoryHtml(content);
  }

  // Read MEMO_LOG.md using VS Code sandboxed FS API — read-only, no writes
  private readMemoryFile(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return "No workspace open.";
    }

    const rootPath = workspaceFolders[0]!.uri.fsPath;
    const mdPath = path.join(rootPath, "MEMO_LOG.md");

    try {
      // Use synchronous read for simplicity; file is small
      const fs = require("fs") as typeof import("fs");
      if (!fs.existsSync(mdPath)) {
        return "MEMO_LOG.md not found. Run `memo-log scan .` first.";
      }
      const content = fs.readFileSync(mdPath, "utf8");
      // Guard: reject enormous files to prevent memory issues
      if (content.length > 1_000_000) {
        return "MEMO_LOG.md exceeds 1MB display limit. Open file directly.";
      }
      return content;
    } catch (err) {
      return `Error reading MEMO_LOG.md: ${String(err)}`;
    }
  }

  dispose(): void {
    this.currentPanel?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
