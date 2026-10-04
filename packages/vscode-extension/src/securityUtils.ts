export const ALLOWED_COMMANDS = new Set(["scan", "audit"]);

export function buildScanArgs(rootPath: string): string[] {
  return ["scan", rootPath];
}

export function validateMemoLogArgs(args: string[]): void {
  const subcommand = args[0];
  if (!subcommand || !ALLOWED_COMMANDS.has(subcommand)) {
    throw new Error(`memo-log: Disallowed command "${subcommand ?? ""}". Only scan/audit are permitted.`);
  }
  for (const arg of args) {
    if (/[;&|`$\\]/.test(arg)) {
      throw new Error(`memo-log: Shell metacharacter detected in argument "${arg}". Rejecting.`);
    }
  }
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[/\\]/.test(p);
}

export function buildMemoryHtml(markdownContent: string): string {
  const escaped = markdownContent
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Memory</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; margin: 0; }
    pre { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-textBlockQuote-background); padding: 12px; border-radius: 4px; }
    .label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  </style>
</head>
<body>
  <p class="label">Read-only · Deterministic · Zero-token · Updated on scan</p>
  <pre>${escaped}</pre>
</body>
</html>`;
}
