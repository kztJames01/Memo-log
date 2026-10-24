import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadEffectiveConfig, runScanCommand } from "../src/engine/index.js";
import { loadCache } from "../src/engine/cache.js";
import { writeWatchConfirmed } from "../src/engine/watchConfirm.js";
import { isExcludedRelativePath, startWatcher } from "../src/engine/watcher.js";

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
    expect(after).toContain("Recent Changes");
    const cache = loadCache(root);
    expect(cache?.files["src/app.ts"]?.hash).toBeTruthy();
  }, 15000);

  it("rescans every file in a burst instead of dropping events past the first batch", async () => {
    const root = await tempDir("memolog-watch-batch-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
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
    await fs.writeFile(path.join(root, "src", "seed.ts"), "export function seedValue() { return 0; }\n", "utf8");

    const config = await loadEffectiveConfig({ targetDir: root });
    await runScanCommand({
      targetDir: root,
      format: "both",
      effectiveConfig: config,
      quiet: true,
    });

    const controller = startWatcher({
      rootDir: root,
      config,
      sigOptions: { filter: "logic", trackTypes: false },
      quiet: true,
    });
    await controller.whenReady();

    const names = Array.from({ length: 12 }, (_, index) => `fn${index}`);
    await Promise.all(names.map((name) => fs.writeFile(
      path.join(root, "src", `${name}.ts`),
      `export function ${name}() { return 1; }\n`,
      "utf8",
    )));

    const mdPath = path.join(root, "AI_MEMORY.md");
    const after = await waitForFileContains(mdPath, "fn11", 20000);
    await controller.stop();
    for (const name of names) {
      expect(after).toContain(name);
    }
  }, 25000);
});

describe("watch exclude matching", () => {
  it("matches directory names without substring false positives", () => {
    expect(isExcludedRelativePath("dist/app.ts", ["dist"])).toBe(true);
    expect(isExcludedRelativePath("src/dist/app.ts", ["dist"])).toBe(true);
    expect(isExcludedRelativePath("distribution/app.ts", ["dist"])).toBe(false);
    expect(isExcludedRelativePath("src/auth/login.ts", ["src/auth"])).toBe(true);
  });
});
