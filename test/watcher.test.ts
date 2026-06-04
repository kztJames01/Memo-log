import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadEffectiveConfig, runScanCommand } from "../src/engine/index.js";
import { loadCache } from "../src/engine/cache.js";
import { writeWatchConfirmed } from "../src/engine/watchConfirm.js";
import { startWatcher } from "../src/engine/watcher.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function seedWatchProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "app.ts"),
    "export function greet(name: string) { return `hi ${name}`; }\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, ".memolog.json"),
    JSON.stringify({
      languages: ["ts"],
      exclude: ["node_modules", ".git", ".memo-log"],
      output: { markdown: "AI_MEMORY.md", json: "AI_MEMORY.json" },
      maxDepth: 10,
      mode: "dual",
      filter: "logic",
    }),
    "utf8",
  );
}

async function waitForFileContains(filePath: string, needle: string, timeoutMs = 12000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = await fs.readFile(filePath, "utf8");
    if (text.includes(needle)) {
      return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return fs.readFile(filePath, "utf8");
}

describe("watcher", () => {
  it("updates markdown after file change with cache populated", async () => {
    const root = await tempDir("memolog-watch-");
    await seedWatchProject(root);
    writeWatchConfirmed(root);

    const config = await loadEffectiveConfig({ targetDir: root });
    await runScanCommand({
      targetDir: root,
      format: "both",
      effectiveConfig: config,
      quiet: true,
    });

    const mdPath = path.join(root, "AI_MEMORY.md");
    const before = await fs.readFile(mdPath, "utf8");
    expect(before).toContain("greet");

    const controller = startWatcher({
      rootDir: root,
      config,
      sigOptions: { filter: "logic", trackTypes: false },
      quiet: true,
    });
    await controller.whenReady();

    await fs.writeFile(
      path.join(root, "src", "app.ts"),
      [
        "export function greet(name: string) { return `hello ${name}`; }",
        "export function versionTag() { return 1; }",
        "",
      ].join("\n"),
      "utf8",
    );

    const after = await waitForFileContains(mdPath, "versionTag");
    await controller.stop();
    expect(after).toContain("versionTag");
    const cache = loadCache(root);
    expect(cache?.files["src/app.ts"]?.hash).toBeTruthy();
  }, 15000);
});
