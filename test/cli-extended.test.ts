import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("cli phase 4 integration", () => {
  it("scan --infer-runtime writes inference markdown from real scan outputs", async () => {
    const root = await makeTempDir("memolog-cli-infer-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "routes.ts"),
      [
        "export function getUsers(req, res) { return listUsers(req); }",
        "export function listUsers(req) { return req.users; }",
        "app.get('/users', getUsers);",
      ].join("\n"),
      "utf8",
    );

    const exitCode = await runCli(["scan", root, "--infer-runtime", "--format", "both"]);
    const inferenceMd = await fs.readFile(path.join(root, "MEMO_LOG_INFERENCE.md"), "utf8");

    expect(exitCode).toBe(0);
    expect(inferenceMd).toContain("Runtime Behavior Inference");
    expect(inferenceMd).toContain("API Endpoints");
  });

  it("scan --agent-ui detects conflict against previous snapshot on second run", async () => {
    const root = await makeTempDir("memolog-cli-agent-ui-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    const target = path.join(root, "src", "auth.ts");

    await fs.writeFile(target, "export function loginUser(username, password) { return username + password; }\n", "utf8");

    const firstExit = await runCli(["scan", root, "--agent-ui", "--format", "md"]);
    expect(firstExit).toBe(0);
    await fs.access(path.join(root, ".memo-log", "agent-ui.snapshot.json"));

    await fs.writeFile(target, "export function loginUser(credentials) { return credentials.username + credentials.password; }\n", "utf8");
    const secondExit = await runCli(["scan", root, "--agent-ui", "--format", "md"]);
    const conflictMd = await fs.readFile(path.join(root, "MEMO_LOG_CONFLICTS.md"), "utf8");

    expect(secondExit).toBe(0);
    expect(conflictMd).toContain("CONFLICT");
    expect(conflictMd).toContain("loginUser");
  });

  it("scan --infer-runtime warns when inference file cap is applied", async () => {
    const root = await makeTempDir("memolog-cli-infer-cap-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    for (let i = 0; i < 51; i++) {
      await fs.writeFile(
        path.join(root, "src", `f${i}.ts`),
        `export function fn${i}(req) { return req?.value ?? ${i}; }\n`,
        "utf8",
      );
    }

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((entry) => String(entry)).join(" "));
    };
    try {
      const exitCode = await runCli(["scan", root, "--infer-runtime", "--format", "both"]);
      expect(exitCode).toBe(0);
      expect(warnings.some((line) => line.includes("INFERENCE_FILE_CAP_APPLIED"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("scan --export-context writes stripped MEMO_LOG_CONTEXT.json", async () => {
    const root = await makeTempDir("memolog-cli-export-ctx-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "util.ts"), "export function clip(s: string) { return s.slice(0, 1); }\n", "utf8");
    const exit = await runCli(["scan", root, "--export-context", "--format", "both"]);
    const raw = await fs.readFile(path.join(root, "MEMO_LOG_CONTEXT.json"), "utf8");
    const parsed = JSON.parse(raw) as { kind: string; entries: Array<{ ref: string; tech: string }> };
    expect(exit).toBe(0);
    expect(parsed.kind).toBe("memo-log-export-context");
    expect(parsed.entries.some((e) => e.tech.includes("clip") || e.ref.includes("util.ts"))).toBe(true);
    expect(raw).not.toContain("generatedAt");
  });
});
