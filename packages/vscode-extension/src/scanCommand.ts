import * as vscode from "vscode";
import { execa } from "execa";
import { StatusBarManager } from "./statusBar.js";
import {
  buildScanArgs,
  validateMemoLogArgs,
  isAbsolutePath,
} from "./securityUtils.js";

// tries memo-log on PATH first, falls back to npx
// never uses shell interpolation

export async function runScan(rootPath: string, statusBar: StatusBarManager): Promise<void> {
  if (!isAbsolutePath(rootPath)) {
    void vscode.window.showErrorMessage("memo-log: Invalid workspace path.");
    return;
  }

  const outputChannel = vscode.window.createOutputChannel("Memo-log Scan");
  outputChannel.clear();
  outputChannel.show(true);
  outputChannel.appendLine(`Running memo-log scan on: ${rootPath}`);
  outputChannel.appendLine("---");

  const args = buildScanArgs(rootPath);
  validateMemoLogArgs(args);

  const envVars = {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "",
    NODE_PATH: process.env["NODE_PATH"] ?? "",
  };

  try {
    // try memo-log directly first (installed globally or in PATH)
    let usedNpx = false;
    try {
      const result = await execa("memo-log", args, {
        cwd: rootPath,
        shell: false,
        timeout: 60_000,
        env: envVars,
      });
      outputChannel.appendLine(result.stdout ?? "");
      if (result.stderr) outputChannel.appendLine(result.stderr);
    } catch (directErr: unknown) {
      // if ENOENT means not on PATH, fall back to npx
      const isNotFound = directErr instanceof Error && "code" in directErr && (directErr as { code: string }).code === "ENOENT";
      if (!isNotFound) throw directErr;

      outputChannel.appendLine("memo-log not on PATH, using npx...");
      usedNpx = true;
      const result = await execa("npx", ["memo-log", ...args], {
        cwd: rootPath,
        shell: false,
        timeout: 60_000,
        env: envVars,
      });
      outputChannel.appendLine(result.stdout ?? "");
      if (result.stderr) outputChannel.appendLine(result.stderr);
    }

    outputChannel.appendLine("---");
    outputChannel.appendLine(`Scan complete.${usedNpx ? " (via npx)" : ""}`);
    statusBar.updateFromMemoryFile();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`ERROR: ${msg}`);
    void vscode.window.showErrorMessage(`memo-log scan failed: ${msg}`);
  }
}
