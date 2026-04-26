import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("cli behavior", () => {
  it("init creates config in empty repo", async () => {
    const root = await makeTempDir("aimemory-cli-init-");
    const exitCode = await runCli(["init", root]);

    const configPath = path.join(root, ".aimemory.json");
    const file = await fs.readFile(configPath, "utf8");

    expect(exitCode).toBe(0);
    expect(file).toContain("\"mode\": \"dual\"");
  });

  it("init is idempotent without --force", async () => {
    const root = await makeTempDir("aimemory-cli-idempotent-");
    const configPath = path.join(root, ".aimemory.json");

    await runCli(["init", root]);
    await fs.writeFile(configPath, "{\"mode\":\"simple\"}\n", "utf8");
    const exitCode = await runCli(["init", root]);
    const file = await fs.readFile(configPath, "utf8");

    expect(exitCode).toBe(0);
    expect(file).toBe("{\"mode\":\"simple\"}\n");
  });

  it("scan emits deterministic output for unchanged input", async () => {
    const root = await makeTempDir("aimemory-cli-scan-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const firstExit = await runCli(["scan", root, "--format", "md"]);
    const firstOutput = await fs.readFile(path.join(root, "AI_MEMORY.md"), "utf8");

    await fs.rm(path.join(root, ".ai-memory"), { recursive: true, force: true });
    await fs.rm(path.join(root, "AI_MEMORY.md"), { force: true });
    const secondExit = await runCli(["scan", root, "--format", "md"]);
    const secondOutput = await fs.readFile(path.join(root, "AI_MEMORY.md"), "utf8");

    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);
    expect(secondOutput).toBe(firstOutput);
  });

  it("scan exits non-zero when --out is used with --format both", async () => {
    const root = await makeTempDir("aimemory-cli-out-");
    await runCli(["init", root]);
    const exitCode = await runCli([
      "scan",
      root,
      "--format",
      "both",
      "--out",
      "memory.md"
    ]);

    expect(exitCode).not.toBe(0);
  });

  it("scan appends session notes only when --include-agent-notes is enabled", async () => {
    const root = await makeTempDir("aimemory-cli-notes-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "feature.ts"), "export const featureFlag = true;\n", "utf8");
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Session\n- Updated feature flag\n", "utf8");

    const exitCode = await runCli([
      "scan",
      root,
      "--mode",
      "dual",
      "--format",
      "md",
      "--include-agent-notes",
    ]);

    const output = await fs.readFile(path.join(root, "AI_MEMORY.md"), "utf8");
    expect(exitCode).toBe(0);
    expect(output).toContain("Session Notes (Unverified Agent Metadata)");
    expect(output).toContain("AGENTS.md");
  });

  it("scan tech mode uses deterministic structural pipeline", async () => {
    const root = await makeTempDir("aimemory-cli-tech-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "auth.ts"), "export function loginUser() { return true; }\n", "utf8");

    const firstExit = await runCli(["scan", root, "--mode", "tech", "--format", "md"]);
    const firstOutput = await fs.readFile(path.join(root, "AI_MEMORY.md"), "utf8");

    await fs.rm(path.join(root, ".ai-memory"), { recursive: true, force: true });
    await fs.rm(path.join(root, "AI_MEMORY.md"), { force: true });
    const secondExit = await runCli(["scan", root, "--mode", "tech", "--format", "md"]);
    const secondOutput = await fs.readFile(path.join(root, "AI_MEMORY.md"), "utf8");

    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);
    expect(firstOutput).toBe(secondOutput);
    expect(firstOutput).toContain("Engineering Ledger (Technical)");
  });
});
