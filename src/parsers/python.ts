// regex-based python parser plugin.
import type {
  Export,
  ExportKind,
  ExtractionResult,
  Import,
  ParserPlugin,
  GenericParseResult,
} from "./types.js";

const SUPPORTED_EXTENSIONS = [".py", ".pyi"] as const;

const MAX_LINE_LENGTH = 16 * 1024;

// matches: def name( or async def name(
const FUNC_PATTERN = /^(?:async\s+)?def\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)/;
// matches: class Name or class Name(Parent):
const CLASS_PATTERN = /^class\s+([a-zA-Z_]\w*)\s*(?:\(([^)]*)\))?\s*:/;
// matches: import module or import module as alias
const IMPORT_PATTERN = /^import\s+((?:[a-zA-Z_]\w*(?:\s+as\s+\w+)?(?:\s*,\s*)?)+)/;
// matches: from module import name1, name2
const FROM_IMPORT_PATTERN = /^from\s+([^\s]+)\s+import\s+(.+)/;
// matches: __all__ = ["name1", "name2"]
const ALL_PATTERN = /^__all__\s*=\s*\[/;

function extractDocstring(lines: string[], startLine: number): string | undefined {
  if (startLine >= lines.length) return undefined;

  const trimmed = lines[startLine]?.trim() ?? "";
  const isTripleDouble = trimmed.startsWith('"""');
  const isTripleSingle = trimmed.startsWith("'''");

  if (!isTripleDouble && !isTripleSingle) return undefined;

  const quote = isTripleDouble ? '"""' : "'''";

  // single-line docstring: """text"""
  const singleLine = trimmed.slice(3, -3).trim();
  if (trimmed.endsWith(quote) && trimmed.length > 6) {
    return singleLine || undefined;
  }

  // multi-line docstring
  const docLines: string[] = [];
  // first line content after opening quotes
  const firstContent = trimmed.slice(3).trim();
  if (firstContent) docLines.push(firstContent);

  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes(quote)) {
      const closingContent = line.split(quote)[0]?.trim();
      if (closingContent) docLines.push(closingContent);
      break;
    }
    docLines.push(line.trim());
  }

  const result = docLines.join(" ").trim();
  return result.length > 0 ? result : undefined;
}
function extractSignaturesFromContent(content: string): ExtractionResult["signatures"] {
  const signatures: ExtractionResult["signatures"] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.length > MAX_LINE_LENGTH ? rawLine.slice(0, MAX_LINE_LENGTH) : rawLine;
    const trimmed = line.trim();

    // only match top-level definitions (no leading whitespace)
    if (/^\s/.test(rawLine)) continue;

    const funcMatch = FUNC_PATTERN.exec(trimmed);
    if (funcMatch) {
      const isAsync = trimmed.startsWith("async");
      const name = funcMatch[1] ?? "anonymous";
      const params = (funcMatch[2] ?? "")
        .split(",")
        .map((p) => p.trim().split(/[:\s=]/)[0] ?? "")
        .filter(Boolean)
        .filter((p) => p !== "self" && p !== "cls");

      signatures.push({
        name,
        signature: `${isAsync ? "async " : ""}def ${name}(${params.join(", ")})`,
        line: i + 1,
        column: rawLine.indexOf(trimmed),
        async: isAsync,
        generator: false,
        params,
        jsdoc: extractDocstring(lines, i + 1),
      });
    }
  }

  return signatures;
}

function extractExports(content: string): Export[] {
  const exports: Export[] = [];
  const lines = content.split("\n");
  const allNames = new Set<string>();

  // first pass: collect __all__ entries if present.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (ALL_PATTERN.test(line.trim())) {
      // parse __all__ = [...] possibly spanning multiple lines
      let allContent = line;
      let j = i;
      while (!allContent.includes("]") && j + 1 < lines.length) {
        j++;
        allContent += lines[j] ?? "";
      }
      const nameMatches = allContent.matchAll(/['"]([a-zA-Z_]\w*)['"]/g);
      for (const match of nameMatches) {
        if (match[1]) allNames.add(match[1]);
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.length > MAX_LINE_LENGTH ? rawLine.slice(0, MAX_LINE_LENGTH) : rawLine;
    const trimmed = line.trim();

    // skip indented definitions (methods, nested functions)
    if (/^\s/.test(rawLine)) continue;

    const funcMatch = FUNC_PATTERN.exec(trimmed);
    if (funcMatch) {
      const name = funcMatch[1] ?? "anonymous";
      // skip private names unless in __all__
      if (name.startsWith("_") && !allNames.has(name)) continue;

      exports.push({
        name,
        kind: "function" as ExportKind,
        line: i + 1,
        column: rawLine.indexOf(trimmed),
        jsdoc: extractDocstring(lines, i + 1),
      });
      continue;
    }

    const classMatch = CLASS_PATTERN.exec(trimmed);
    if (classMatch) {
      const name = classMatch[1] ?? "AnonymousClass";
      if (name.startsWith("_") && !allNames.has(name)) continue;

      exports.push({
        name,
        kind: "class" as ExportKind,
        line: i + 1,
        column: rawLine.indexOf(trimmed),
        jsdoc: extractDocstring(lines, i + 1),
      });
      continue;
    }

    // module-level constant assignments (UPPER_CASE or simple names)
    const constMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
    if (constMatch && constMatch[1]) {
      exports.push({
        name: constMatch[1],
        kind: "const" as ExportKind,
        line: i + 1,
        column: rawLine.indexOf(trimmed),
      });
      continue;
    }

    // simple variable assignments at module level
    const varMatch = trimmed.match(/^([a-zA-Z_]\w*)\s*[:=]/);
    if (varMatch && varMatch[1] && !varMatch[1].startsWith("_")) {
      // only emit if in __all__ or looks like a public constant
      if (allNames.has(varMatch[1])) {
        exports.push({
          name: varMatch[1],
          kind: "const" as ExportKind,
          line: i + 1,
          column: rawLine.indexOf(trimmed),
        });
      }
    }
  }

  return exports;
}

function extractImports(content: string): Import[] {
  const imports: Import[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.length > MAX_LINE_LENGTH ? rawLine.slice(0, MAX_LINE_LENGTH) : rawLine;
    const trimmed = line.trim();

    // skip indented imports (inside try/except, etc.)
    if (/^\s/.test(rawLine)) continue;

    const fromMatch = FROM_IMPORT_PATTERN.exec(trimmed);
    if (fromMatch) {
      const modulePath = fromMatch[1] ?? "";
      const namesRaw = fromMatch[2] ?? "";

      // handle: from x import (a, b, c) with possible line continuations
      const names = namesRaw
        .replace(/[()]/g, "")
        .split(",")
        .map((n) => {
          const parts = n.trim().split(/\s+as\s+/);
          return (parts[0] ?? "").trim();
        })
        .filter(Boolean);

      imports.push({
        path: modulePath,
        names,
        line: i + 1,
        column: rawLine.indexOf(trimmed),
        importKind: "value",
      });
      continue;
    }

    const importMatch = IMPORT_PATTERN.exec(trimmed);
    if (importMatch) {
      const modules = (importMatch[1] ?? "")
        .split(",")
        .map((m) => {
          const parts = m.trim().split(/\s+as\s+/);
          return (parts[0] ?? "").trim();
        })
        .filter(Boolean);

      for (const mod of modules) {
        imports.push({
          path: mod,
          names: [mod],
          line: i + 1,
          column: rawLine.indexOf(trimmed),
          importKind: "value",
        });
      }
    }
  }

  return imports;
}

// token type for the generic parse result (no real AST for regex parser).
interface PythonToken {
  type: "regex-token";
  contentLength: number;
}

export const pythonParser: ParserPlugin<PythonToken> = {
  extensions: SUPPORTED_EXTENSIONS,
  language: "Python",
  lang: "py",

  parse(content: string, filePath: string, timeoutMs = 500): GenericParseResult<PythonToken> {
    const startTime = Date.now();
    const parseTimeMs = Date.now() - startTime;

    if (parseTimeMs > timeoutMs) {
      return {
        success: false,
        error: `Parse exceeded timeout: ${parseTimeMs}ms > ${timeoutMs}ms`,
        parseTimeMs,
      };
    }

    return {
      success: true,
      ast: { type: "regex-token", contentLength: content.length },
      parseTimeMs,
    };
  },

  extract(_ast: PythonToken, filePath: string, content?: string): ExtractionResult {
    const source = content ?? "";
    return {
      exports: extractExports(source),
      imports: extractImports(source),
      signatures: extractSignaturesFromContent(source),
    };
  },
};
