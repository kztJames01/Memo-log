// parser plugin registry for safe, deterministic extraction.
import { createHash } from "node:crypto";

import {
  SAFE_EXTENSIONS,
  PARSER_LIMITS,
  type ParserPlugin,
  type ParsedFile,
  type BabelAst,
} from "./types.js";
import { jsTsParser } from "./jsTs.js";
import { safeRegexParse } from "./safeParse.js";
import { withTimeout } from "./timeout.js";

// currently supported parser plugins.
const parserPlugins: ParserPlugin[] = [jsTsParser];

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
    ".ai-memory",
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

  // skip disallowed files before doing any heavy work.
  if (!isSafeToParse(filePath)) {
    warnings.push(`SKIP: Unsafe or unsupported extension: ${filePath}`);
    return {
      path: filePath,
      contentHash,
      exports: [],
      imports: [],
      signatures: [],
      usedFallback: false,
      warnings,
    };
  }

  // hard limit to avoid big-file parse pressure.
  if (fileSizeBytes > PARSER_LIMITS.MAX_FILE_SIZE_BYTES) {
    warnings.push(`SKIP: File exceeds ${PARSER_LIMITS.MAX_FILE_SIZE_BYTES} byte limit: ${filePath}`);
    return {
      path: filePath,
      contentHash,
      exports: [],
      imports: [],
      signatures: [],
      usedFallback: false,
      warnings,
    };
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
    return {
      path: filePath,
      contentHash,
      exports: result.exports,
      imports: result.imports,
      signatures: result.signatures,
      usedFallback: true,
      warnings,
    };
  }

  // choose parser by extension.
  const parser = findParser(filePath);

  if (!parser) {
    warnings.push(`SKIP: No parser for extension: ${filePath}`);
    return {
      path: filePath,
      contentHash,
      exports: [],
      imports: [],
      signatures: [],
      usedFallback: false,
      warnings,
    };
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

    return {
      path: filePath,
      contentHash,
      exports: result.exports,
      imports: result.imports,
      signatures: result.signatures,
      usedFallback: true,
      warnings,
    };
  }

  // warn when parse is slow but still valid.
  if (parseResult.parseTimeMs && parseResult.parseTimeMs > PARSER_LIMITS.MAX_PARSE_TIME_MS / 2) {
    warnings.push(`SLOW_PARSE: ${filePath} took ${parseResult.parseTimeMs}ms`);
  }

  // extract normalized structures from ast output.
  const extraction = extractFromAst(parser, parseResult.ast, filePath, content);

  return {
    path: filePath,
    contentHash,
    exports: extraction.exports,
    imports: extraction.imports,
    signatures: extraction.signatures,
    jsdoc: extraction.jsdoc,
    usedFallback: false,
    warnings,
  };
}

// extracts data using parser-specific behavior.
function extractFromAst(
  parser: ParserPlugin,
  ast: BabelAst,
  filePath: string,
  content: string
): { exports: ParsedFile["exports"]; imports: ParsedFile["imports"]; signatures: ParsedFile["signatures"]; jsdoc?: ParsedFile["jsdoc"] } {
  // js/ts parser uses source content to recover jsdoc snippets.
  if (parser === jsTsParser) {
    const result = jsTsParser.extract(ast, filePath, content);
    return {
      exports: result.exports,
      imports: result.imports,
      signatures: result.signatures,
      jsdoc: result.jsdoc,
    };
  }

  const result = parser.extract(ast, filePath);
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
