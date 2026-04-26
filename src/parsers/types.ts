import type { File } from "@babel/types";

// normalized export kinds emitted by parser plugins.
export type ExportKind = "function" | "class" | "const" | "type" | "default";

export interface Export {
  name: string;
  kind: ExportKind;
  line: number;
  column: number;
  jsdoc?: string | undefined;
}

export interface Import {
  path: string;
  names: string[];
  line: number;
  column: number;
  importKind: "value" | "type" | "dynamic";
}

export interface Signature {
  name: string;
  signature: string;
  line: number;
  column: number;
  async: boolean;
  generator: boolean;
  params: string[];
  jsdoc?: string | undefined;
}

export interface JsDocBlock {
  description?: string | undefined;
  params?: Record<string, string> | undefined;
  returns?: string | undefined;
}

export interface ParsedFile {
  path: string;
  contentHash: string;
  exports: Export[];
  imports: Import[];
  signatures: Signature[];
  jsdoc?: JsDocBlock | undefined;
  usedFallback: boolean;
  warnings: string[];
}

export interface ExtractionResult {
  exports: Export[];
  imports: Import[];
  signatures: Signature[];
  jsdoc?: JsDocBlock | undefined;
}

export type BabelAst = File;

export interface ParseResult {
  success: boolean;
  ast?: BabelAst;
  error?: string;
  parseTimeMs?: number;
}

// parser plugin contract used by parser registry in index.ts.
export interface ParserPlugin {
  readonly extensions: readonly string[];
  readonly language: string;
  parse(
    content: string,
    filePath: string,
    timeoutMs?: number
  ): ParseResult;
  // content is optional so lightweight parsers can ignore source text.
  extract(ast: BabelAst, filePath: string, content?: string): ExtractionResult;
}

// hard limits keep parser work bounded and deterministic.
export const PARSER_LIMITS = {
  MAX_FILE_SIZE_BYTES: 2 * 1024 * 1024,
  MAX_PARSE_TIME_MS: 500,
  MAX_FALLBACK_SIZE_BYTES: 100 * 1024,
} as const;

export const SAFE_EXTENSIONS = [".js", ".ts", ".jsx", ".tsx"] as const;
