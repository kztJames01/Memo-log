import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertWatchAllowed, isWatchConfirmed, watchConfirmPath } from "../src/engine/watchConfirm.js";
import { CliError } from "../src/engine/errors.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("watch confirm", () => {
  it("requires --confirm on first watch", async () => {
    const root = await tempDir("memolog-watch-confirm-");
    expect(isWatchConfirmed(root)).toBe(false);
    expect(() => assertWatchAllowed(root, false)).toThrow(CliError);
  });

  it("writes marker when confirm flag set", async () => {
    const root = await tempDir("memolog-watch-confirm-ok-");
    assertWatchAllowed(root, true);
    expect(isWatchConfirmed(root)).toBe(true);
    const marker = await fs.readFile(watchConfirmPath(root), "utf8");
    expect(marker.trim()).toBe("1");
  });
});
