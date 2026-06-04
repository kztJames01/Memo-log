import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

// Shows last scan time, file count, and warnings in VS Code status bar (read-only)
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "memo-log.openMemory";
    this.item.tooltip = "Click to open AI Memory panel";
    this.item.text = "$(brain) memo-log";
    this.item.show();
  }

  updateFromMemoryFile(): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;

    const jsonPath = path.join(workspaceFolders[0]!.uri.fsPath, "MEMO_LOG.json");
    try {
      if (!fs.existsSync(jsonPath)) {
        this.item.text = "$(brain) memo-log: not scanned";
        return;
      }

      const raw = fs.readFileSync(jsonPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      const generatedAt = typeof parsed["generatedAt"] === "string" ? parsed["generatedAt"] : "";
      const entries = Array.isArray(parsed["entries"]) ? parsed["entries"] : [];
      const warnings = Array.isArray(parsed["warnings"]) ? parsed["warnings"] : [];
      const metadata = (parsed["metadata"] ?? {}) as Record<string, unknown>;
      const totalFiles = typeof metadata["totalFiles"] === "number" ? metadata["totalFiles"] : entries.length;

      const timeLabel = generatedAt ? formatTime(generatedAt) : "unknown";
      const warnLabel = (warnings as unknown[]).length > 0 ? ` ⚠${(warnings as unknown[]).length}` : "";
      this.item.text = `$(brain) memo-log: ${totalFiles} files · ${timeLabel}${warnLabel}`;
    } catch {
      this.item.text = "$(brain) memo-log: error reading state";
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
