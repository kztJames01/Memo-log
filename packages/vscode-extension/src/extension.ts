import * as vscode from "vscode";
import { MemoryPanel } from "./readOnlyProvider.js";
import { MemoryCodeLensProvider } from "./codeLens.js";
import { StatusBarManager } from "./statusBar.js";
import { MemoryTreeProvider } from "./memoryTree.js";
import { runScan } from "./scanCommand.js";
import { getMemoryPaths, clearPathCache } from "./memoryPaths.js";

let statusBar: StatusBarManager | undefined;
let codeLensProvider: MemoryCodeLensProvider | undefined;
let panel: MemoryPanel | undefined;
let tree: MemoryTreeProvider | undefined;
let scanDebounce: ReturnType<typeof setTimeout> | undefined;

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
        // reload so everything registers properly
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
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
    await updateHasMemoryContext();
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

  // watch for memory file changes (both default and custom paths)
  const watcher = vscode.workspace.createFileSystemWatcher("**/{MEMO_LOG,memo_log,*}.{md,json}");
  const onFileChange = () => {
    panel?.refresh();
    tree?.refresh();
    void statusBar?.updateFromMemoryFile();
    void updateHasMemoryContext();
  };
  watcher.onDidChange(onFileChange);
  watcher.onDidCreate(onFileChange);

  // watch .memolog.json for config changes
  const configWatcher = vscode.workspace.createFileSystemWatcher("**/.memolog.json");
  configWatcher.onDidChange(() => {
    clearPathCache();
    onFileChange();
  });
  configWatcher.onDidCreate(() => {
    clearPathCache();
    onFileChange();
  });

  // scanOnSave — debounced
  const saveWatcher = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!vscode.workspace.isTrusted) return;
    const cfg = vscode.workspace.getConfiguration("memo-log");
    if (!cfg.get<boolean>("scanOnSave", false)) return;
    // don't rescan on saving the memory files themselves
    const name = doc.fileName;
    if (name.endsWith("MEMO_LOG.md") || name.endsWith("MEMO_LOG.json")) return;

    if (scanDebounce) clearTimeout(scanDebounce);
    scanDebounce = setTimeout(async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) return;
      await runScan(folders[0]!.uri.fsPath, statusBar!);
      panel?.refresh();
      tree?.refresh();
    }, 800);
  });

  context.subscriptions.push(scanCmd, openCmd, detailCmd, codeLens, treeView, watcher, configWatcher, saveWatcher);
  context.subscriptions.push(statusBar, codeLensProvider, tree);

  void statusBar.updateFromMemoryFile();
  void updateHasMemoryContext();
}

// check if memory files actually exist before showing the tree
async function updateHasMemoryContext(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.commands.executeCommand("setContext", "memo-log.hasMemory", false);
    return;
  }
  const rootUri = folders[0]!.uri;
  const paths = await getMemoryPaths(rootUri);
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(rootUri, paths.md));
    void vscode.commands.executeCommand("setContext", "memo-log.hasMemory", true);
  } catch {
    void vscode.commands.executeCommand("setContext", "memo-log.hasMemory", false);
  }
}

export function deactivate(): void {
  if (scanDebounce) clearTimeout(scanDebounce);
  statusBar?.dispose();
  panel?.dispose();
  tree?.dispose();
}
