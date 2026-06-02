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
    "Watch mode requires first-time confirmation. Re-run with: memo-log scan <dir> --watch --confirm",
    ExitCode.ConfigError,
  );
}
