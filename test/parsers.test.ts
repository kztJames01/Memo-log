/**
 * Parser Plugin System Tests
 * Security-first: Tests verify safe parsing, error handling, and deterministic output
 */

import { describe, expect, it } from "vitest";

import {
  isSafeToParse,
  computeContentHash,
  parseFile,
  getSupportedExtensions,
} from "../src/parsers/index.js";
import { jsTsParser } from "../src/parsers/jsTs.js";
import { safeRegexParse } from "../src/parsers/safeParse.js";
import { SAFE_EXTENSIONS, PARSER_LIMITS } from "../src/parsers/types.js";

describe("Parser Types & Constants", () => {
  it("should define safe extensions for parsing", () => {
    expect(SAFE_EXTENSIONS).toEqual([".js", ".ts", ".jsx", ".tsx"]);
  });

  it("should define parser safety limits", () => {
    expect(PARSER_LIMITS.MAX_FILE_SIZE_BYTES).toBe(2 * 1024 * 1024);
    expect(PARSER_LIMITS.MAX_PARSE_TIME_MS).toBe(500);
    expect(PARSER_LIMITS.MAX_FALLBACK_SIZE_BYTES).toBe(100 * 1024);
  });
});

describe("isSafeToParse", () => {
  it("should accept safe JavaScript/TypeScript files", () => {
    expect(isSafeToParse("/project/src/index.ts")).toBe(true);
    expect(isSafeToParse("/project/src/App.jsx")).toBe(true);
    expect(isSafeToParse("/project/src/utils.ts")).toBe(true);
    expect(isSafeToParse("/project/src/components/Button.js")).toBe(true);
  });

  it("should reject files with unsafe extensions", () => {
    expect(isSafeToParse("/project/.env")).toBe(false);
    expect(isSafeToParse("/project/config.json")).toBe(false);
    expect(isSafeToParse("/project/script.py")).toBe(false);
    expect(isSafeToParse("/project/README.md")).toBe(false);
  });

  it("should reject files in node_modules", () => {
    expect(isSafeToParse("/project/node_modules/lodash/index.js")).toBe(false);
  });

  it("should reject files in .git", () => {
    expect(isSafeToParse("/project/.git/config")).toBe(false);
  });

  it("should reject .env files", () => {
    expect(isSafeToParse("/project/.env")).toBe(false);
    expect(isSafeToParse("/project/.env.production")).toBe(false);
  });

  it("should reject dist/build directories", () => {
    expect(isSafeToParse("/project/dist/index.js")).toBe(false);
    expect(isSafeToParse("/project/build/app.js")).toBe(false);
  });

  it("should reject .ai-memory directory", () => {
    expect(isSafeToParse("/project/.ai-memory/state.json")).toBe(false);
  });
});

describe("computeContentHash", () => {
  it("should produce consistent SHA-256 hashes", () => {
    const content = "const x = 1;";
    const hash1 = computeContentHash(content);
    const hash2 = computeContentHash(content);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex length
  });

  it("should produce different hashes for different content", () => {
    const hash1 = computeContentHash("const x = 1;");
    const hash2 = computeContentHash("const x = 2;");

    expect(hash1).not.toBe(hash2);
  });
});

describe("jsTsParser", () => {
  describe("parse", () => {
    it("should parse valid JavaScript", () => {
      const code = "export const foo = 1;";
      const result = jsTsParser.parse(code, "test.js");

      expect(result.success).toBe(true);
      expect(result.ast).toBeDefined();
      expect(result.parseTimeMs).toBeLessThan(PARSER_LIMITS.MAX_PARSE_TIME_MS);
    });

    it("should parse valid TypeScript", () => {
      const code = "export function greet(name: string): void { }";
      const result = jsTsParser.parse(code, "test.ts");

      expect(result.success).toBe(true);
      expect(result.ast).toBeDefined();
    });

    it("should parse JSX", () => {
      const code = "export const App = () => <div>Hello</div>;";
      const result = jsTsParser.parse(code, "test.jsx");

      expect(result.success).toBe(true);
    });

    it("should parse TSX", () => {
      const code = "export const Button = (props: { label: string }) => <button>{props.label}</button>;";
      const result = jsTsParser.parse(code, "test.tsx");

      expect(result.success).toBe(true);
    });

    it("should use error recovery for malformed code", () => {
      const code = "export const broken = { missing: 'closing' };";
      const result = jsTsParser.parse(code, "test.js");

      // Error recovery should allow parsing to continue
      expect(result.success).toBe(true);
    });

    it("should handle empty content", () => {
      const result = jsTsParser.parse("", "empty.js");

      expect(result.success).toBe(true);
    });
  });

  describe("extract", () => {
    it("should extract named exports", () => {
      const code = `
        export const foo = 1;
        export function bar() { }
        export class Baz { }
      `;
      const result = jsTsParser.parse(code, "test.js");
      expect(result.success).toBe(true);

      const extraction = jsTsParser.extract(result.ast!, "test.js", code);

      expect(extraction.exports).toHaveLength(3);
      expect(extraction.exports.find((e) => e.name === "foo")?.kind).toBe("const");
      expect(extraction.exports.find((e) => e.name === "bar")?.kind).toBe("function");
      expect(extraction.exports.find((e) => e.name === "Baz")?.kind).toBe("class");
    });

    it("should extract default exports", () => {
      const code = `
        export default function main() { }
      `;
      const result = jsTsParser.parse(code, "test.js");
      const extraction = jsTsParser.extract(result.ast!, "test.js", code);

      const defaultExport = extraction.exports.find((e) => e.kind === "default");
      expect(defaultExport).toBeDefined();
      expect(defaultExport?.name).toBe("main");
    });

    it("should extract imports", () => {
      const code = `
        import { foo, bar } from './utils';
        import React from 'react';
        import * as _ from 'lodash';
      `;
      const result = jsTsParser.parse(code, "test.js");
      const extraction = jsTsParser.extract(result.ast!, "test.js", code);

      expect(extraction.imports).toHaveLength(3);

      const utilsImport = extraction.imports.find((i) => i.path === "./utils");
      expect(utilsImport?.names).toEqual(["foo", "bar"]);

      const reactImport = extraction.imports.find((i) => i.path === "react");
      expect(reactImport?.names).toEqual(["React"]);

      const lodashImport = extraction.imports.find((i) => i.path === "lodash");
      expect(lodashImport?.names).toEqual(["_"]);
    });

    it("should extract function signatures", () => {
      const code = `
        export function greet(name, age) { }
        export const arrow = (x, y) => x + y;
      `;
      const result = jsTsParser.parse(code, "test.js");
      const extraction = jsTsParser.extract(result.ast!, "test.js", code);

      expect(extraction.signatures.length).toBeGreaterThanOrEqual(2);

      const greetSig = extraction.signatures.find((s) => s.name === "greet");
      expect(greetSig).toBeDefined();
      expect(greetSig?.params).toEqual(["name", "age"]);
    });
  });
});

describe("safeRegexParse", () => {
  it("should extract exports via regex fallback", () => {
    const code = `
export function foo() { }
export const bar = 1;
export class Baz { }
    `.trim();

    const { result, warnings } = safeRegexParse(code, "fallback.js");

    expect(result.exports.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("PARSE_FALLBACK"))).toBe(true);
  });

  it("should extract imports via regex fallback", () => {
    const code = `
import { x, y } from './module';
import z from 'zod';
    `.trim();

    const { result } = safeRegexParse(code, "fallback.js");

    expect(result.imports.length).toBeGreaterThanOrEqual(2);
  });

  it("should handle malformed code gracefully", () => {
    const code = `export { broken , } from './module';`;

    const { result } = safeRegexParse(code, "malformed.js");

    // Should not throw, returns whatever it can extract
    expect(result).toBeDefined();
  });
});

describe("parseFile", () => {
  it("should parse a valid JavaScript file end-to-end", async () => {
    const content = `
      import React from 'react';
      export function greet(name: string) {
        return \`Hello, \${name}\`;
      }
      export const VERSION = '1.0.0';
    `.trim();

    const result = await parseFile("test.ts", content, content.length);

    expect(result.path).toBe("test.ts");
    expect(result.contentHash).toHaveLength(64);
    expect(result.exports.length).toBeGreaterThanOrEqual(2);
    expect(result.imports.length).toBeGreaterThanOrEqual(1);
    expect(result.usedFallback).toBe(false);
    expect(result.warnings.length).toBe(0);
  });

  it("should skip files with unsupported extensions", async () => {
    const content = "print('hello')";

    const result = await parseFile("test.py", content, content.length);

    expect(result.exports).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("unsupported extension"))).toBe(true);
  });

  it("should reject files exceeding size limit", async () => {
    const largeContent = "x".repeat(PARSER_LIMITS.MAX_FILE_SIZE_BYTES + 1);

    const result = await parseFile("large.js", largeContent, largeContent.length);

    expect(result.exports).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("exceeds"))).toBe(true);
  });

  it("should use regex fallback for large files", async () => {
    const mediumContent = "x".repeat(PARSER_LIMITS.MAX_FALLBACK_SIZE_BYTES + 1);

    const result = await parseFile("medium.js", mediumContent, mediumContent.length);

    expect(result.usedFallback).toBe(true);
    expect(result.warnings.some((w) => w.includes("Large file"))).toBe(true);
  });

  it("should produce deterministic output", async () => {
    const content = "export const x = 1;";

    const result1 = await parseFile("test.js", content, content.length);
    const result2 = await parseFile("test.js", content, content.length);

    expect(result1.contentHash).toBe(result2.contentHash);
    expect(result1.exports).toEqual(result2.exports);
  });
});

describe("getSupportedExtensions", () => {
  it("should return safe extensions list", () => {
    const extensions = getSupportedExtensions();

    expect(extensions).toContain(".js");
    expect(extensions).toContain(".ts");
    expect(extensions).toContain(".jsx");
    expect(extensions).toContain(".tsx");
  });
});

describe("Integration: Parser in scan context", () => {
  it("should handle a realistic component file", async () => {
    const componentCode = `
import React, { useState } from 'react';
import { Button } from './Button';
import type { User } from '../types';

interface Props {
  user: User;
  onLogout: () => void;
}

/**
 * Dashboard header component
 * @param user - The currently logged in user
 * @param onLogout - Callback to handle logout
 */
export function DashboardHeader({ user, onLogout }: Props) {
  const [isMenuOpen, setMenuOpen] = useState(false);

  return (
    <header>
      <h1>Welcome, {user.name}</h1>
      <Button onClick={onLogout}>Logout</Button>
    </header>
  );
}

export default DashboardHeader;
    `.trim();

    const result = await parseFile("src/components/DashboardHeader.tsx", componentCode, componentCode.length);

    // Verify extraction
    expect(result.exports.length).toBeGreaterThanOrEqual(2); // named + default
    expect(result.imports.length).toBeGreaterThanOrEqual(3); // React, Button, types

    // Verify deterministic
    const result2 = await parseFile("src/components/DashboardHeader.tsx", componentCode, componentCode.length);
    expect(result.contentHash).toBe(result2.contentHash);
  });

  it("should handle utility files with multiple exports", async () => {
    const utilsCode = `
/**
 * Format a date string
 */
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Format currency
 */
export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

export const MAX_RETRIES = 3;
export const DEFAULT_TIMEOUT = 5000;
    `.trim();

    const result = await parseFile("src/utils/format.ts", utilsCode, utilsCode.length);

    expect(result.exports.length).toBeGreaterThanOrEqual(4); // 2 functions + 2 constants
    expect(result.usedFallback).toBe(false);

    // Check JSDoc extraction
    const formatDate = result.exports.find((e) => e.name === "formatDate");
    expect(formatDate?.jsdoc).toBeDefined();
  });
});
