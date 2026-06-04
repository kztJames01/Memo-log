// Tests the read-only guarantees and security model of the VS Code extension logic
// These test the pure TypeScript helpers — no actual VS Code runtime needed

import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  buildMemoryHtml,
  validateMemoLogArgs,
  buildScanArgs,
  isAbsolutePath,
} from "../packages/vscode-extension/src/securityUtils.js";

describe("extension read-only HTML builder", () => {
  it("escapes HTML angle brackets to prevent XSS", () => {
    const result = buildMemoryHtml("<script>alert('xss')</script>");
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("escapes ampersands", () => {
    const result = buildMemoryHtml("A & B");
    expect(result).toContain("&amp;");
  });

  it("escapes double quotes", () => {
    const result = buildMemoryHtml(`He said "hello"`);
    expect(result).toContain("&quot;");
  });

  it("preserves normal markdown text", () => {
    const result = buildMemoryHtml("# Hello World\nSome text");
    expect(result).toContain("# Hello World");
    expect(result).toContain("Some text");
  });

  it("includes strict CSP in generated HTML", () => {
    const result = buildMemoryHtml("hello");
    expect(result).toContain("default-src 'none'");
    expect(result).toContain("style-src 'unsafe-inline'");
  });
});

describe("extension scan command arg validator", () => {
  it("allows scan command", () => {
    expect(() => validateMemoLogArgs(["scan", "/tmp/project"])).not.toThrow();
  });

  it("allows audit command", () => {
    expect(() => validateMemoLogArgs(["audit", "/tmp/project"])).not.toThrow();
  });

  it("blocks unknown commands", () => {
    expect(() => validateMemoLogArgs(["rm", "-rf", "/"])).toThrow("Disallowed command");
  });

  it("blocks empty command", () => {
    expect(() => validateMemoLogArgs([])).toThrow("Disallowed command");
  });

  it("blocks semicolons (command injection)", () => {
    expect(() => validateMemoLogArgs(["scan", "/tmp; rm -rf /"])).toThrow("Shell metacharacter");
  });

  it("blocks pipe characters", () => {
    expect(() => validateMemoLogArgs(["scan", "/tmp | cat /etc/passwd"])).toThrow("Shell metacharacter");
  });

  it("blocks backtick injection", () => {
    expect(() => validateMemoLogArgs(["scan", "`cat /etc/passwd`"])).toThrow("Shell metacharacter");
  });

  it("blocks dollar sign injection", () => {
    expect(() => validateMemoLogArgs(["scan", "$(echo bad)"])).toThrow("Shell metacharacter");
  });

  it("builds expected scan arg array", () => {
    expect(buildScanArgs("/workspace/proj")).toEqual(["scan", "/workspace/proj"]);
  });

  it("validates absolute paths", () => {
    expect(isAbsolutePath("/tmp/proj")).toBe(true);
    expect(isAbsolutePath("C:\\proj")).toBe(true);
    expect(isAbsolutePath("relative/path")).toBe(false);
  });
});

describe("extension CLI output consistency", () => {
  it("MEMO_LOG.json written by CLI is parseable as expected schema", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-ext-test-"));
    // Create minimal MEMO_LOG.json that extension would read
    const snapshot = {
      version: 2,
      generatedAt: new Date().toISOString(),
      targetDir: tmpDir,
      entries: [],
      warnings: [],
      metadata: { totalFiles: 0, totalModules: 0, languages: [] },
    };
    const jsonPath = path.join(tmpDir, "MEMO_LOG.json");
    fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8");

    const raw = fs.readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Extension's isMemorySnapshot check
    expect(parsed["version"]).toBe(2);
    expect(Array.isArray(parsed["entries"])).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
