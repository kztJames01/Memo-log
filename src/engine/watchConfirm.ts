import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CACHE_DIR } from "./cache.js";
import { CliError, ExitCode } from "./errors.js";

const WATCH_CONFIRM_FILENAME = "watch.confirmed";

export function watchConfirmPath(rootDir: string): string {
  return join(rootDir, CACHE_DIR, WATCH_CONFIRM_FILENAME);
}

export function isWatchConfirmed(rootDir: string): boolean {
  return existsSync(watchConfirmPath(rootDir));
}

export function writeWatchConfirmed(rootDir: string): void {
  const dir = join(rootDir, CACHE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(watchConfirmPath(rootDir), "1\n", "utf8");
}

export function assertWatchAllowed(rootDir: string, confirmFlag: boolean): void {
  if (isWatchConfirmed(rootDir)) {
    return;
  }
  if (confirmFlag) {
    writeWatchConfirmed(rootDir);
    return;
  }
  throw new CliError(
    "Watch mode requires one-time confirmation. Run in a terminal, or create .memo-log/watch.confirmed",
    ExitCode.ConfigError,
  );
}

export async function ensureWatchAllowed(rootDir: string, confirmFlag: boolean): Promise<void> {
  if (isWatchConfirmed(rootDir)) {
    return;
  }
  if (confirmFlag) {
    writeWatchConfirmed(rootDir);
    return;
  }
  if (!process.stdin.isTTY) {
    throw new CliError(
      "Watch mode requires one-time confirmation to monitor files. Re-run in a terminal (you'll get a y/N prompt), or create .memo-log/watch.confirmed",
      ExitCode.ConfigError,
    );
  }
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer = "";
  try {
    answer = await rl.question("Watch mode requires one-time confirmation to monitor files. Allow? (y/N) ");
  } finally {
    rl.close();
  }
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new CliError("Watch mode not confirmed.", ExitCode.ConfigError);
  }
  writeWatchConfirmed(rootDir);
}
