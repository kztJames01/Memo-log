import * as vscode from "vscode";

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "memo-log.openMemory";
    this.item.tooltip = "Click to open AI Memory panel";
    this.item.text = "$(brain) memo-log";
    this.item.show();
  }

  async updateFromMemoryFile(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;

    const jsonUri = vscode.Uri.joinPath(workspaceFolders[0]!.uri, "MEMO_LOG.json");
    try {
      const buf = await vscode.workspace.fs.readFile(jsonUri);
      const parsed = JSON.parse(new TextDecoder("utf-8").decode(buf)) as Record<string, unknown>;

      const generatedAt = typeof parsed["generatedAt"] === "string" ? parsed["generatedAt"] : "";
      const entries = Array.isArray(parsed["entries"]) ? parsed["entries"] : [];
      const warnings = Array.isArray(parsed["warnings"]) ? parsed["warnings"] : [];
      const metadata = (parsed["metadata"] ?? {}) as Record<string, unknown>;
      const totalFiles = typeof metadata["totalFiles"] === "number" ? metadata["totalFiles"] : entries.length;

      const timeLabel = generatedAt ? formatTime(generatedAt) : "unknown";
      const warnLabel = warnings.length > 0 ? ` ⚠${warnings.length}` : "";
      this.item.text = `$(brain) memo-log: ${totalFiles} files · ${timeLabel}${warnLabel}`;
    } catch {
      this.item.text = "$(brain) memo-log: not scanned";
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    return `${Math.floor(diffH / 24)}d ago`;
  } catch {
    return "unknown";
  }
}
