// regex fallback parser with bounded behavior.
import type {
  Export,
  ExportKind,
  ExtractionResult,
  Import,
  JsDocBlock,
  Signature,
} from "./types.js";

const MAX_REGEX_CONTENT_BYTES = 512 * 1024;
const MAX_REGEX_LINE_LENGTH = 16 * 1024;

// regex patterns for export extraction.
const EXPORT_PATTERNS = [
  {
    // export function name(...) { ... }
    pattern: /^export\s+function\s+(\w+)/gm,
    kind: "function" as ExportKind,
  },
  {
    // export async function name(...) { ... }
    pattern: /^export\s+async\s+function\s+(\w+)/gm,
    kind: "function" as ExportKind,
  },
  {
    // export const name = ...
    pattern: /^export\s+const\s+(\w+)\s*=/gm,
    kind: "const" as ExportKind,
  },
  {
    // export let name = ...
    pattern: /^export\s+let\s+(\w+)\s*=/gm,
    kind: "const" as ExportKind,
  },
  {
    // export class Name { ... }
    pattern: /^export\s+class\s+(\w+)/gm,
    kind: "class" as ExportKind,
  },
  {
    // export default function name(...) { ... }
    pattern: /^export\s+default\s+function\s+(\w+)/gm,
    kind: "default" as ExportKind,
  },
  {
    // export default class Name { ... }
    pattern: /^export\s+default\s+class\s+(\w+)/gm,
    kind: "default" as ExportKind,
  },
  {
    // export { name1, name2 }
    pattern: /^export\s+\{([^}]+)\}/gm,
    kind: "const" as ExportKind,
  },
];

// regex patterns for import extraction.
const IMPORT_PATTERNS: Array<{
  pattern: RegExp;
  parse: (match: RegExpMatchArray) => { names: string[]; path: string };
}> = [
  {
    // import x from 'module'
    pattern: /^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/gm,
    parse: (match: RegExpMatchArray): { names: string[]; path: string } => ({
      names: [match[1] ?? ""],
      path: match[2] ?? "",
    }),
  },
  {
    // import { x, y } from 'module'
    pattern: /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gm,
    parse: (match: RegExpMatchArray): { names: string[]; path: string } => ({
      names: (match[1] ?? "").split(",").map((n) => n.trim()),
      path: match[2] ?? "",
    }),
  },
  {
    // import * as x from 'module'
    pattern: /^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/gm,
    parse: (match: RegExpMatchArray): { names: string[]; path: string } => ({
      names: [match[1] ?? ""],
      path: match[2] ?? "",
    }),
  },
  {
    // import 'module' (side-effect import)
    pattern: /^import\s+['"]([^'"]+)['"]/gm,
    parse: (match: RegExpMatchArray): { names: string[]; path: string } => ({
      names: [],
      path: match[1] ?? "",
    }),
  },
];

// regex patterns for basic signature extraction.
const SIGNATURE_PATTERNS = [
  {
    // function name(...) { ... }
    pattern: /(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g,
  },
  {
    // (param) => ...
    pattern: /const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/g,
  },
  {
    // class Name { constructor(...) { ... } }
    pattern: /class\s+(\w+)[^{]*\{[^}]*constructor\s*\(([^)]*)\)/g,
  },
];

// reads nearby jsdoc text for fallback metadata.
function extractJSDoc(content: string, position: number): JsDocBlock | undefined {
  // find current line bounds.
  const beforePosition = content.substring(0, position);
  const lastNewline = beforePosition.lastIndexOf("\n");
  const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;

  // check preceding text for a jsdoc block.
  const prevLines = beforePosition.substring(lineStart);
  const jsdocMatch = prevLines.match(/\/\*\*[\s\S]*?\*\//);

  if (!jsdocMatch || !jsdocMatch[0]) {
    return undefined;
  }

  const jsdoc = jsdocMatch[0];

  // pull first readable description line.
  const descMatch = jsdoc.match(/@description\s+(.+)/);
  const description = descMatch
    ? (descMatch[1]?.trim() ?? undefined)
    : jsdoc
        .split("\n")[1]
        ?.replace(/^\s*\*\s*/, "")
        .trim();

  // parse @param tags.
  const params: Record<string, string> = {};
  const paramMatches = [...jsdoc.matchAll(/@param\s+(?:\[[^\]]+\]\s+)?(\w+)(?:\s+-\s+)?(.+)?/g)];
  for (const match of paramMatches) {
    if (match[1]) {
      params[match[1]] = (match[2] || "").trim();
    }
  }

  return {
    description,
    params: Object.keys(params).length > 0 ? params : undefined,
  };
}

// parses content with regex fallback when ast path fails.
export function parseWithRegex(
  content: string,
  _filePath: string
): ExtractionResult {
  const exports: Export[] = [];
  const imports: Import[] = [];
  const signatures: Signature[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const safeLine = line.length > MAX_REGEX_LINE_LENGTH
      ? line.slice(0, MAX_REGEX_LINE_LENGTH)
      : line;

    // extract exports.
    for (const { pattern, kind } of EXPORT_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(safeLine);

      if (match && match.index !== undefined) {
        const name = match[1] || match[0];
        const position = i; // use line index for jsdoc lookup.

        // split named export list.
        if (kind === "const" && match[1]?.includes(",")) {
          const names = match[1].split(",").map((n) => n.trim());
          for (const n of names) {
            exports.push({
              name: n,
              kind: "const",
              line: i + 1,
              column: safeLine.indexOf(n),
              jsdoc: extractJSDoc(content, position)?.description,
            });
          }
        } else {
          exports.push({
            name,
            kind: match[0].includes("default") ? "default" : kind,
            line: i + 1,
            column: match.index,
            jsdoc: extractJSDoc(content, position)?.description,
          });
        }
        break; // move to next line after first match.
      }
    }

    // extract imports.
    for (const { pattern, parse } of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(safeLine);

      if (match && match.index !== undefined) {
        const parsed = parse(match);
        imports.push({
          path: parsed.path,
          names: parsed.names,
          line: i + 1,
          column: match.index,
          importKind: "value",
        });
        break;
      }
    }

    // extract signatures.
    for (const { pattern } of SIGNATURE_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(safeLine)) !== null) {
        if (match.index !== undefined) {
          const name = match[1];
          const params = match[2] || "";
          const isAsync = match[0].includes("async");

          signatures.push({
            name: name ?? "anonymous",
            signature: match[0].replace(/\s+/g, " ").trim(),
            line: i + 1,
            column: match.index,
            async: isAsync,
            generator: false,
            params: params
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean),
          });
        }
      }
    }
  }

  return { exports, imports, signatures };
}

// safe wrapper that adds warnings instead of throwing.
export function safeRegexParse(
  content: string,
  filePath: string
): { result: ExtractionResult; warnings: string[] } {
  const warnings: string[] = [];

  try {
    if (Buffer.byteLength(content, "utf8") > MAX_REGEX_CONTENT_BYTES) {
      warnings.push(`WARN: PARSE_FALLBACK_SKIPPED - ${filePath} exceeds regex safety limit (${MAX_REGEX_CONTENT_BYTES} bytes)`);
      return {
        result: { exports: [], imports: [], signatures: [] },
        warnings,
      };
    }

    const result = parseWithRegex(content, filePath);

    // warn clearly when fallback found little or no structure.
    if (result.exports.length === 0 && result.imports.length === 0) {
      warnings.push(`WARN: PARSE_FALLBACK - No exports/imports found in ${filePath}`);
    } else {
      warnings.push(`WARN: PARSE_FALLBACK - Used regex fallback for ${filePath}`);
    }

    return { result, warnings };
  } catch (error) {
    warnings.push(`WARN: PARSE_FALLBACK_ERROR - ${filePath}: ${error}`);
    return {
      result: { exports: [], imports: [], signatures: [] },
      warnings,
    };
  }
}
