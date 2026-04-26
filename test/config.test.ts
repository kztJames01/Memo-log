import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadAiMemoryConfig } from "../src/engine/config.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("config validation", () => {
  it("accepts a valid .aimemory.json", async () => {
    const root = await makeTempDir("aimemory-config-valid-");
    const configPath = path.join(root, ".aimemory.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          languages: ["ts", "js"],
          exclude: ["node_modules", ".git"],
          output: { markdown: "docs/AI_MEMORY.md", json: "docs/AI_MEMORY.json" },
          maxDepth: 10,
          mode: "tech"
        },
        null,
        2
      ),
      "utf8"
    );

    const loaded = loadAiMemoryConfig({ targetDir: root });
    expect(loaded.loadedFromFile).toBe(true);
    expect(loaded.config.mode).toBe("tech");
    expect(loaded.config.maxDepth).toBe(10);
  });

  it("rejects invalid mode", async () => {
    const root = await makeTempDir("aimemory-config-mode-");
    const configPath = path.join(root, ".aimemory.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          languages: ["ts"],
          exclude: [".git"],
          output: { markdown: "AI_MEMORY.md", json: "AI_MEMORY.json" },
          maxDepth: 5,
          mode: "invalid"
        },
        null,
        2
      ),
      "utf8"
    );

    expect(() => loadAiMemoryConfig({ targetDir: root })).toThrow();
  });

  it("rejects negative maxDepth", async () => {
    const root = await makeTempDir("aimemory-config-depth-");
    const configPath = path.join(root, ".aimemory.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          languages: ["ts"],
          exclude: [".git"],
          output: { markdown: "AI_MEMORY.md", json: "AI_MEMORY.json" },
          maxDepth: -1,
          mode: "simple"
        },
        null,
        2
      ),
      "utf8"
    );

    expect(() => loadAiMemoryConfig({ targetDir: root })).toThrow();
  });

  it("rejects malformed output paths", async () => {
    const root = await makeTempDir("aimemory-config-output-");
    const configPath = path.join(root, ".aimemory.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          languages: ["ts"],
          exclude: [".git"],
          output: { markdown: "../AI_MEMORY.md", json: "AI_MEMORY.json" },
          maxDepth: 5,
          mode: "simple"
        },
        null,
        2
      ),
      "utf8"
    );

    expect(() => loadAiMemoryConfig({ targetDir: root })).toThrow();
  });
});
