// regex-based rust parser plugin.
import type {
  Export,
  ExportKind,
  ExtractionResult,
  Import,
  ParserPlugin,
  GenericParseResult,
} from "./types.js";

const SUPPORTED_EXTENSIONS = [".rs"] as const;

const MAX_LINE_LENGTH = 16 * 1024;

function extractDocComment(lines: string[], declLine: number): string | undefined {
  if (declLine < 1) return undefined;

  const docLines: string[] = [];
  let cursor = declLine - 1;

  // walk backward collecting /// or //! lines
  while (cursor >= 0) {
    const line = (lines[cursor] ?? "").trim();
    if (line.startsWith("///") || line.startsWith("//!")) {
      docLines.unshift(line.replace(/^\/\/[\/!]\s?/, ""));
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

    // skip non-pub items
    if (!trimmed.startsWith("pub ")) continue;

    // skip macro_rules
    if (trimmed.includes("macro_rules!")) continue;

    const kind = getRustExportKind(trimmed);
    const name = extractRustName(trimmed, kind);

    if (name) {
      exports.push({
        name,
        kind,
        line: i + 1,
        column: rawLine.indexOf(trimmed),
        jsdoc: extractDocComment(lines, i),
      });
    }
  }

  return exports;
}

function getRustExportKind(line: string): ExportKind {
  if (line.includes("pub fn ") || line.includes("pub async fn ")) return "function";
  if (line.includes("pub struct ")) return "class";
  if (line.includes("pub enum ")) return "class";
  if (line.includes("pub trait ")) return "type";
  if (line.includes("pub type ")) return "type";
  if (line.includes("pub const ")) return "const";
  if (line.includes("pub static ")) return "const";
  if (line.includes("pub mod ")) return "const";
  return "const";
}

function extractRustName(line: string, kind: ExportKind): string | undefined {
  let pattern: RegExp;

  switch (kind) {
    case "function":
      pattern = /(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_]\w*)/;
      break;
    case "class":
      if (line.includes("struct")) {
        pattern = /pub\s+struct\s+([a-zA-Z_]\w*)/;
      } else {
        pattern = /pub\s+enum\s+([a-zA-Z_]\w*)/;
      }
      break;
    case "type":
      if (line.includes("trait")) {
        pattern = /pub\s+trait\s+([a-zA-Z_]\w*)/;
      } else {
        pattern = /pub\s+type\s+([a-zA-Z_]\w*)/;
      }
      break;
    case "const":
      if (line.includes("const ")) {
        pattern = /pub\s+const\s+([a-zA-Z_]\w*)/;
      } else if (line.includes("static ")) {
        pattern = /pub\s+static\s+([a-zA-Z_]\w*)/;
      } else {
        pattern = /pub\s+mod\s+([a-zA-Z_]\w*)/;
      }
      break;
    default:
      pattern = /pub\s+\w+\s+([a-zA-Z_]\w*)/;
  }

  const match = pattern.exec(line);
  return match?.[1];
}

function extractImports(content: string): Import[] {
  const imports: Import[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.length > MAX_LINE_LENGTH ? rawLine.slice(0, MAX_LINE_LENGTH) : rawLine;
    const trimmed = line.trim();

    // use path::to::module;
    const useMatch = trimmed.match(/^use\s+([^{;]+)(?:\{([^}]+)\})?\s*;?/);
    if (useMatch) {
      const basePath = (useMatch[1] ?? "").trim();
      const groupContent = useMatch[2];

      if (groupContent) {
        // use path::{name1, name2};
        const names = groupContent
          .split(",")
          .map((n) => n.trim().split("::").pop()?.trim() ?? "")
          .filter(Boolean);
        imports.push({
          path: basePath.replace(/::$/, ""),
          names,
          line: i + 1,
          column: rawLine.indexOf(trimmed),
          importKind: "value",
        });
      } else {
        // use path::to::name;
        const name = basePath.split("::").pop()?.trim() ?? basePath;
        imports.push({
          path: basePath,
          names: [name],
          line: i + 1,
          column: rawLine.indexOf(trimmed),
          importKind: "value",
        });
      }
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

    // skip non-pub fn lines
    if (!trimmed.startsWith("pub ")) continue;
    if (trimmed.includes("macro_rules!")) continue;

    const fnMatch = trimmed.match(/(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)/);
    if (fnMatch) {
      const isAsync = trimmed.includes("async fn");
      const name = fnMatch[1] ?? "anonymous";
      const rawParams = fnMatch[2] ?? "";

      const params = rawParams
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && p !== "self" && p !== "&self" && p !== "&mut self")
        .map((p) => {
          // extract param name before ":"
          const parts = p.split(":");
          return (parts[0] ?? "").trim().replace(/^&\s*(mut\s+)?/, "");
        })
        .filter(Boolean);

      signatures.push({
        name,
        signature: `${isAsync ? "async " : ""}fn ${name}(${params.join(", ")})`,
        line: i + 1,
        column: rawLine.indexOf(trimmed),
        async: isAsync,
        generator: false,
        params,
        jsdoc: extractDocComment(lines, i),
      });
    }
  }

  return signatures;
}

interface RustToken {
  type: "regex-token";
  contentLength: number;
}

export const rustParser: ParserPlugin<RustToken> = {
  extensions: SUPPORTED_EXTENSIONS,
  language: "Rust",
  lang: "rs",

  parse(content: string, filePath: string, timeoutMs = 500): GenericParseResult<RustToken> {
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

  extract(_ast: RustToken, filePath: string, content?: string): ExtractionResult {
    const source = content ?? "";
    return {
      exports: extractExports(source),
      imports: extractImports(source),
      signatures: extractSignaturesFromContent(source),
    };
  },
};
