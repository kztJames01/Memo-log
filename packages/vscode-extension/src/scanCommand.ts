import * as vscode from "vscode";
import { execa } from "execa";
import { StatusBarManager } from "./statusBar.js";
import {
  buildScanArgs,
  validateMemoLogArgs,
  isAbsolutePath,
} from "./securityUtils.js";

// executes memo-log CLI via execa (arg array, no shell interpolation)
// only whitelisted command: npx memo-log scan <path>
// never uses child_process.exec or shell interpolation

export async function runScan(rootPath: string, statusBar: StatusBarManager): Promise<void> {
  // Guard: rootPath must be an absolute path inside the workspace
  if (!isAbsolutePath(rootPath)) {
    void vscode.window.showErrorMessage("memo-log: Invalid workspace path.");
    return;
  }

  const outputChannel = vscode.window.createOutputChannel("Memo-log Scan");
  outputChannel.clear();
  outputChannel.show(true);
  outputChannel.appendLine(`Running memo-log scan on: ${rootPath}`);
  outputChannel.appendLine("---");

  try {
    // Build arg array — never interpolate rootPath into a shell string
    const args = buildScanArgs(rootPath);
    validateMemoLogArgs(args); // hard safety check before exec

    const result = await execa("npx", ["memo-log", ...args], {
      cwd: rootPath,
      // No shell: true — args are passed as array, never shell-expanded
      shell: false,
      timeout: 60_000,
      // strip env to prevent PATH injection; preserve NODE_PATH for npx
      env: {
        PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env["HOME"] ?? "",
        NODE_PATH: process.env["NODE_PATH"] ?? "",
      },
    });

    outputChannel.appendLine(result.stdout ?? "");
    if (result.stderr) outputChannel.appendLine(result.stderr);
    outputChannel.appendLine("---");
    outputChannel.appendLine("Scan complete.");
    statusBar.updateFromMemoryFile();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`ERROR: ${msg}`);
    void vscode.window.showErrorMessage(`memo-log scan failed: ${msg}`);
  }
}
