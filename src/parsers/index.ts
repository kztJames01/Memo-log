// parser plugin registry for safe, deterministic extraction.
import { createHash } from "node:crypto";

import {
  SAFE_EXTENSIONS,
  PARSER_LIMITS,
  detectLang,
  type ParserPlugin,
  type ParsedFile,
  type BabelAst,
} from "./types.js";
import { jsTsParser } from "./jsTs.js";
import { pythonParser } from "./python.js";
import { rustParser } from "./rust.js";
import { goParser } from "./go.js";
import { safeRegexParse } from "./safeParse.js";
import { withTimeout } from "./timeout.js";

// all registered parser plugins.
const parserPlugins: ParserPlugin[] = [jsTsParser, pythonParser, rustParser, goParser];

// checks if the file path is allowed for parsing.
export function isSafeToParse(filePath: string): boolean {
  const ext = getExtension(filePath);
  const lowerPath = filePath.toLowerCase();

  // reject unsupported extensions early.
  if (!SAFE_EXTENSIONS.includes(ext as typeof SAFE_EXTENSIONS[number])) {
    return false;
  }

  // block sensitive or generated folders.
  const dangerousPatterns = [
    "node_modules",
    ".git",
    ".env",
    ".npmrc",
    ".yarnrc",
    "dist/",
    "build/",
    ".memo-log",
  ];

  for (const pattern of dangerousPatterns) {
    if (lowerPath.includes(pattern)) {
      return false;
    }
  }

  return true;
}

// returns lowercase extension, or empty string.
function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filePath.substring(lastDot).toLowerCase();
}

// picks a parser plugin by file extension.
function findParser(filePath: string): ParserPlugin | undefined {
  const ext = getExtension(filePath);

  for (const plugin of parserPlugins) {
    if (plugin.extensions.includes(ext as never)) {
      return plugin;
    }
  }

  return undefined;
}

// hashes content with normalized newlines for cross-os determinism.
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

// parses a single file with strict limits and fallbacks.
export async function parseFile(
  filePath: string,
  content: string,
  fileSizeBytes: number
): Promise<ParsedFile> {
  const warnings: string[] = [];
  const contentHash = computeContentHash(content);
  const lang = detectLang(filePath);

  // skip disallowed files before doing any heavy work.
  if (!isSafeToParse(filePath)) {
    warnings.push(`SKIP: Unsafe or unsupported extension: ${filePath}`);
    return validateParsedFile({
      path: filePath,
      lang,
      contentHash,
      exports: [],
      imports: [],
      signatures: [],
      usedFallback: false,
      warnings,
    });
  }

  // hard limit to avoid big-file parse pressure.
  if (fileSizeBytes > PARSER_LIMITS.MAX_FILE_SIZE_BYTES) {
    warnings.push(`SKIP: File exceeds ${PARSER_LIMITS.MAX_FILE_SIZE_BYTES} byte limit: ${filePath}`);
    return validateParsedFile({
      path: filePath,
      lang,
      contentHash,
      exports: [],
      imports: [],
      signatures: [],
      usedFallback: false,
      warnings,
    });
  }

  // for large files, use bounded regex parsing instead of full ast.
  if (fileSizeBytes > PARSER_LIMITS.MAX_FALLBACK_SIZE_BYTES) {
    warnings.push(`WARN: Large file (${fileSizeBytes} bytes), using regex fallback: ${filePath}`);
    const { result, warnings: regexWarnings } = await withTimeout(
      Promise.resolve().then(() => safeRegexParse(content, filePath)),
      PARSER_LIMITS.MAX_PARSE_TIME_MS,
      `Regex fallback parse for ${filePath}`,
    );
    warnings.push(...regexWarnings);
    return validateParsedFile({
      path: filePath,
      lang,
      contentHash,
      exports: sortExports(result.exports),
      imports: sortImports(result.imports),
      signatures: sortSignatures(result.signatures),
      usedFallback: true,
      warnings,
    });
  }

  // choose parser by extension.
  const parser = findParser(filePath);

  if (!parser) {
    warnings.push(`SKIP: No parser for extension: ${filePath}`);
    return validateParsedFile({
      path: filePath,
      lang,
      contentHash,
      exports: [],
      imports: [],
      signatures: [],
      usedFallback: false,
      warnings,
    });
  }

  // timeout wrapper prevents parser hangs from blocking scan.
  let parseResult;
  try {
    parseResult = await withTimeout(
      Promise.resolve().then(() => parser.parse(content, filePath, PARSER_LIMITS.MAX_PARSE_TIME_MS)),
      PARSER_LIMITS.MAX_PARSE_TIME_MS,
      `AST parse for ${filePath}`,
    );
  } catch (error) {
    parseResult = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      parseTimeMs: PARSER_LIMITS.MAX_PARSE_TIME_MS,
    };
  }

  if (!parseResult.success || !parseResult.ast) {
    warnings.push(`WARN: AST parse failed, using regex fallback: ${filePath} - ${parseResult.error}`);

    // fallback keeps scan progress deterministic when ast fails.
    const { result, warnings: regexWarnings } = await withTimeout(
      Promise.resolve().then(() => safeRegexParse(content, filePath)),
      PARSER_LIMITS.MAX_PARSE_TIME_MS,
      `Regex fallback parse for ${filePath}`,
    );
    warnings.push(...regexWarnings);

    return validateParsedFile({
      path: filePath,
      lang,
      contentHash,
      exports: sortExports(result.exports),
      imports: sortImports(result.imports),
      signatures: sortSignatures(result.signatures),
      usedFallback: true,
      warnings,
    });
  }

  // warn when parse is slow but still valid.
  if (parseResult.parseTimeMs && parseResult.parseTimeMs > PARSER_LIMITS.MAX_PARSE_TIME_MS / 2) {
    warnings.push(`SLOW_PARSE: ${filePath} took ${parseResult.parseTimeMs}ms`);
  }

  // extract normalized structures from ast output.
  const extraction = extractFromAst(parser, parseResult.ast, filePath, content);

  return validateParsedFile({
    path: filePath,
    lang,
    contentHash,
    exports: sortExports(extraction.exports),
    imports: sortImports(extraction.imports),
    signatures: sortSignatures(extraction.signatures),
    jsdoc: extraction.jsdoc,
    usedFallback: false,
    warnings,
  });
}

// extracts data using parser-specific behavior.
function extractFromAst(
  parser: ParserPlugin,
  ast: unknown,
  filePath: string,
  content: string
): { exports: ParsedFile["exports"]; imports: ParsedFile["imports"]; signatures: ParsedFile["signatures"]; jsdoc?: ParsedFile["jsdoc"] } {
  // js/ts parser uses source content to recover jsdoc snippets.
  if (parser === jsTsParser) {
    const result = jsTsParser.extract(ast as BabelAst, filePath, content);
    return {
      exports: result.exports,
      imports: result.imports,
      signatures: result.signatures,
      jsdoc: result.jsdoc,
    };
  }

  const result = parser.extract(ast, filePath, content);
  return {
    exports: result.exports,
    imports: result.imports,
    signatures: result.signatures,
    jsdoc: result.jsdoc,
  };
}

// registers a parser plugin after shape checks.
export function registerParser(plugin: ParserPlugin): void {
  // basic guardrails so bad plugins fail fast.
  if (!plugin.extensions?.length) {
    throw new Error("Parser must define extensions");
  }
  if (!plugin.parse || !plugin.extract) {
    throw new Error("Parser must implement parse and extract methods");
  }

  parserPlugins.push(plugin);
}

// returns extensions this runtime can parse safely.
export function getSupportedExtensions(): readonly string[] {
  return SAFE_EXTENSIONS;
}

// validates a ParsedFile object conforms to schema across all languages.
export function validateParsedFile(file: unknown): ParsedFile {
  if (!file || typeof file !== "object") {
    throw new Error("validateParsedFile: expected object, got " + typeof file);
  }

  const f = file as Record<string, unknown>;

  if (typeof f.path !== "string") throw new Error("validateParsedFile: missing or invalid path");
  if (typeof f.contentHash !== "string" || f.contentHash.length !== 64) {
    throw new Error("validateParsedFile: missing or invalid contentHash");
  }
  if (!Array.isArray(f.exports)) throw new Error("validateParsedFile: exports is not an array");
  if (!Array.isArray(f.imports)) throw new Error("validateParsedFile: imports is not an array");
  if (!Array.isArray(f.signatures)) throw new Error("validateParsedFile: signatures is not an array");
  if (typeof f.usedFallback !== "boolean") throw new Error("validateParsedFile: usedFallback is not boolean");
  if (!Array.isArray(f.warnings)) throw new Error("validateParsedFile: warnings is not an array");

  for (const exp of f.exports) {
    const e = exp as Record<string, unknown>;
    if (typeof e.name !== "string") throw new Error("validateParsedFile: export missing name");
    if (typeof e.kind !== "string") throw new Error("validateParsedFile: export missing kind");
    if (typeof e.line !== "number") throw new Error("validateParsedFile: export missing line");
  }

  for (const imp of f.imports) {
    const i = imp as Record<string, unknown>;
    if (typeof i.path !== "string") throw new Error("validateParsedFile: import missing path");
    if (!Array.isArray(i.names)) throw new Error("validateParsedFile: import missing names");
    if (typeof i.line !== "number") throw new Error("validateParsedFile: import missing line");
  }

  return f as unknown as ParsedFile;
}

function sortExports(exports: ParsedFile["exports"]): ParsedFile["exports"] {
  return [...exports].sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.kind.localeCompare(b.kind);
  });
}

function sortImports(imports: ParsedFile["imports"]): ParsedFile["imports"] {
  return [...imports].sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    const byPath = a.path.localeCompare(b.path);
    if (byPath !== 0) return byPath;
    return a.names.join(",").localeCompare(b.names.join(","));
  });
}

function sortSignatures(signatures: ParsedFile["signatures"]): ParsedFile["signatures"] {
  return [...signatures].sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    return a.name.localeCompare(b.name);
  });
}
