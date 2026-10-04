// regex-based go parser plugin.
import type {
  Export,
  ExportKind,
  ExtractionResult,
  Import,
  ParserPlugin,
  GenericParseResult,
} from "./types.js";

const SUPPORTED_EXTENSIONS = [".go"] as const;

const MAX_LINE_LENGTH = 16 * 1024;

function isExportedName(name: string): boolean {
  // Go convention: names starting with uppercase are exported
  return /^[A-Z]/.test(name);
}

function extractGoDoc(lines: string[], declLine: number): string | undefined {
  if (declLine < 1) return undefined;

  const docLines: string[] = [];
  let cursor = declLine - 1;

  // walk backward collecting // comment lines
  while (cursor >= 0) {
    const line = (lines[cursor] ?? "").trim();
    if (line.startsWith("//") && !line.startsWith("//go:")) {
      docLines.unshift(line.replace(/^\/\/\s?/, ""));
      cursor--;
    } else if (line === "") {
      cursor--;
    } else {
      break;
    }
  }

  return docLines.length > 0 ? docLines.join(" ").trim() : undefined;
}

function extractExports(content: string): Export[] {
  const exports: Export[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.length > MAX_LINE_LENGTH ? rawLine.slice(0, MAX_LINE_LENGTH) : rawLine;
    const trimmed = line.trim();

    // skip go:generate directives
    if (trimmed.startsWith("//go:")) continue;
    // skip indented definitions (methods, nested)
    if (/^\s/.test(rawLine)) continue;

    // func Name(...)
    const funcMatch = trimmed.match(/^func\s+([A-Za-z_]\w*)\s*\(/);
    if (funcMatch && funcMatch[1] && isExportedName(funcMatch[1])) {
      exports.push({
        name: funcMatch[1],
        kind: "function" as ExportKind,
        line: i + 1,
        column: rawLine.indexOf(trimmed),
        jsdoc: extractGoDoc(lines, i),
      });
      continue;
    }

    // type Name struct/...
    const typeMatch = trimmed.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface|func|map|\[|chan|\*)/);
    if (typeMatch && typeMatch[1] && isExportedName(typeMatch[1])) {
      exports.push({
        name: typeMatch[1],
        kind: typeMatch[2] === "struct" || typeMatch[2] === "interface" ? "class" as ExportKind : "type" as ExportKind,
        line: i + 1,
        column: rawLine.indexOf(trimmed),
        jsdoc: extractGoDoc(lines, i),
      });
      continue;
    }

    // var Name = ...
    const varMatch = trimmed.match(/^var\s+([A-Za-z_]\w*)\s+/);
    if (varMatch && varMatch[1] && isExportedName(varMatch[1])) {
      exports.push({
        name: varMatch[1],
        kind: "const" as ExportKind,
        line: i + 1,
        column: rawLine.indexOf(trimmed),
        jsdoc: extractGoDoc(lines, i),
      });
      continue;
    }

    // const Name = ...
    const constMatch = trimmed.match(/^const\s+([A-Za-z_]\w*)\s+/);
    if (constMatch && constMatch[1] && isExportedName(constMatch[1])) {
      exports.push({
        name: constMatch[1],
        kind: "const" as ExportKind,
        line: i + 1,
        column: rawLine.indexOf(trimmed),
        jsdoc: extractGoDoc(lines, i),
      });
    }
  }

  return exports;
}

function extractImports(content: string): Import[] {
  const imports: Import[] = [];
  const lines = content.split("\n");

  let inImportBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();

    // import block start
    if (trimmed === "import (") {
      inImportBlock = true;
      continue;
    }

    // import block end
    if (inImportBlock && trimmed === ")") {
      inImportBlock = false;
      continue;
    }

    if (inImportBlock) {
      // "path/to/pkg" or alias "path/to/pkg"
      const match = trimmed.match(/^(?:(\w+)\s+)?["']([^"']+)["']/);
      if (match) {
        const alias = match[1];
        const path = match[2] ?? "";
        const name = alias ?? path.split("/").pop() ?? path;
        imports.push({
          path,
          names: [name],
          line: i + 1,
          column: rawLine.indexOf(trimmed),
          importKind: "value",
        });
      }
      continue;
    }

    // single import "path"
    const singleMatch = trimmed.match(/^import\s+(?:(\w+)\s+)?["']([^"']+)["']/);
    if (singleMatch) {
      const alias = singleMatch[1];
      const path = singleMatch[2] ?? "";
      const name = alias ?? path.split("/").pop() ?? path;
      imports.push({
        path,
        names: [name],
        line: i + 1,
        column: rawLine.indexOf(trimmed),
        importKind: "value",
      });
    }
  }

  return imports;
}

function extractSignaturesFromContent(content: string): ExtractionResult["signatures"] {
  const signatures: ExtractionResult["signatures"] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.length > MAX_LINE_LENGTH ? rawLine.slice(0, MAX_LINE_LENGTH) : rawLine;
    const trimmed = line.trim();

    // skip go:generate, indented methods, init()
    if (trimmed.startsWith("//go:")) continue;
    if (/^\s/.test(rawLine)) continue;

    // func Name(params) (...) { or func Name(params) {
    const funcMatch = trimmed.match(/^func\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
    if (funcMatch) {
      const name = funcMatch[1] ?? "anonymous";

      // skip init()
      if (name === "init") continue;

      const rawParams = funcMatch[2] ?? "";
      const params = rawParams
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          // Go params: name type — extract the name
          const parts = p.split(/\s+/);
          return (parts[0] ?? "").trim();
        })
        .filter(Boolean);

      signatures.push({
        name,
        signature: `func ${name}(${params.join(", ")})`,
        line: i + 1,
        column: rawLine.indexOf(trimmed),
        async: false,
        generator: false,
        params,
        jsdoc: extractGoDoc(lines, i),
      });
    }
  }

  return signatures;
}

interface GoToken {
  type: "regex-token";
  contentLength: number;
}

export const goParser: ParserPlugin<GoToken> = {
  extensions: SUPPORTED_EXTENSIONS,
  language: "Go",
  lang: "go",

  parse(content: string, filePath: string, timeoutMs = 500): GenericParseResult<GoToken> {
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

  extract(_ast: GoToken, filePath: string, content?: string): ExtractionResult {
    const source = content ?? "";
    return {
      exports: extractExports(source),
      imports: extractImports(source),
      signatures: extractSignaturesFromContent(source),
    };
  },
};
