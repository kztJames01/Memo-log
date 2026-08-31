import * as vscode from "vscode";
import { MemoryPanel } from "./readOnlyProvider.js";
import { MemoryCodeLensProvider } from "./codeLens.js";
import { StatusBarManager } from "./statusBar.js";
import { MemoryTreeProvider } from "./memoryTree.js";
import { runScan } from "./scanCommand.js";

let statusBar: StatusBarManager | undefined;
let codeLensProvider: MemoryCodeLensProvider | undefined;
let panel: MemoryPanel | undefined;
let tree: MemoryTreeProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  if (!vscode.workspace.isTrusted) {
    console.warn("memo-log: Disabled in untrusted workspace.");
    return;
  }

  const config = vscode.workspace.getConfiguration("memo-log");
  if (!config.get<boolean>("enabled", false)) {
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
  tree = new MemoryTreeProvider();

  const scanCmd = vscode.commands.registerCommand("memo-log.scanNow", async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      void vscode.window.showErrorMessage("memo-log: No workspace folder open.");
      return;
    }
    const rootPath = workspaceFolders[0]!.uri.fsPath;
    await runScan(rootPath, statusBar!);
    panel?.refresh();
    tree?.refresh();
  });

  const openCmd = vscode.commands.registerCommand("memo-log.openMemory", () => {
    panel?.show();
  });

  const detailCmd = vscode.commands.registerCommand("memo-log.showEntryDetail", (entry: { tech?: string; simple?: string; ref?: string }) => {
    const tech = entry?.tech ?? "";
    const simple = entry?.simple ?? "";
    const ref = entry?.ref ?? "";
    void vscode.window.showInformationMessage(`${simple}\n${tech}\n${ref}`);
  });

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

  const treeView = vscode.window.registerTreeDataProvider("memo-log.memoryPanel", tree);

  const watcher = vscode.workspace.createFileSystemWatcher("**/MEMO_LOG.{md,json}");
  watcher.onDidChange(() => {
    panel?.refresh();
    tree?.refresh();
    void statusBar?.updateFromMemoryFile();
  });
  watcher.onDidCreate(() => {
    panel?.refresh();
    tree?.refresh();
    void statusBar?.updateFromMemoryFile();
  });

  context.subscriptions.push(scanCmd, openCmd, detailCmd, codeLens, treeView, watcher);
  context.subscriptions.push(statusBar, codeLensProvider, tree);

  void statusBar.updateFromMemoryFile();

  void vscode.commands.executeCommand("setContext", "memo-log.hasMemory", true);
}

export function deactivate(): void {
  statusBar?.dispose();
  panel?.dispose();
  tree?.dispose();
}
