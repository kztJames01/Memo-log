import * as vscode from "vscode";
import { MemoryPanel } from "./readOnlyProvider.js";
import { MemoryCodeLensProvider } from "./codeLens.js";
import { StatusBarManager } from "./statusBar.js";
import { runScan } from "./scanCommand.js";

let statusBar: StatusBarManager | undefined;
let codeLensProvider: MemoryCodeLensProvider | undefined;
let panel: MemoryPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Extension disabled in untrusted workspaces — enforced at manifest level too
  if (!vscode.workspace.isTrusted) {
    console.warn("memo-log: Disabled in untrusted workspace.");
    return;
  }

  const config = vscode.workspace.getConfiguration("memo-log");
  if (!config.get<boolean>("enabled", false)) {
    // Show one-time info message to let user opt in
    void vscode.window.showInformationMessage(
      "Memo-log is installed. Enable it in settings (memo-log.enabled = true) to activate the memory panel and code lenses.",
      "Enable Now"
    ).then(choice => {
      if (choice === "Enable Now") {
        void vscode.workspace.getConfiguration("memo-log").update("enabled", true, vscode.ConfigurationTarget.Workspace);
      }
    });
    return;
  }

  statusBar = new StatusBarManager();
  codeLensProvider = new MemoryCodeLensProvider(context);
  panel = new MemoryPanel(context);

  // Register commands — only safe, whitelisted operations
  const scanCmd = vscode.commands.registerCommand("memo-log.scanNow", async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      void vscode.window.showErrorMessage("memo-log: No workspace folder open.");
      return;
    }
    const rootPath = workspaceFolders[0]!.uri.fsPath;
    await runScan(rootPath, statusBar!);
    panel?.refresh();
  });

  const openCmd = vscode.commands.registerCommand("memo-log.openMemory", () => {
    panel?.show();
  });

  // Register code lens provider for all supported languages
  const codeLens = vscode.languages.registerCodeLensProvider(
    [
      { language: "typescript" },
      { language: "javascript" },
      { language: "python" },
      { language: "rust" },
      { language: "go" },
    ],
    codeLensProvider
  );

  // Watch MEMO_LOG files for changes and refresh UI
  const watcher = vscode.workspace.createFileSystemWatcher("**/MEMO_LOG.{md,json}");
  watcher.onDidChange(() => {
    panel?.refresh();
    statusBar?.updateFromMemoryFile();
  });
  watcher.onDidCreate(() => {
    panel?.refresh();
    statusBar?.updateFromMemoryFile();
  });

  context.subscriptions.push(scanCmd, openCmd, codeLens, watcher);
  context.subscriptions.push(statusBar, codeLensProvider);

  // Initial status bar load
  statusBar.updateFromMemoryFile();

  void vscode.commands.executeCommand("setContext", "memo-log.hasMemory", true);
}

export function deactivate(): void {
  statusBar?.dispose();
  panel?.dispose();
}
