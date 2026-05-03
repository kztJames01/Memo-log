import type { SupportedLang, ExportKind } from "../parsers/types.js";

export interface StructuralScanOptions {
  quiet?: boolean | undefined;
  includeAgentNotes?: boolean | undefined;
  timeoutMs?: number | undefined;
  excludes?: string[] | undefined;
  maxDepth?: number | undefined;
  maxFileSizeBytes?: number | undefined;
}

export interface ExportInfo {
  name: string;
  line: number;
  column?: number;
  kind: ExportKind;
}

export interface AstExtract {
  file: string;
  lang?: SupportedLang | undefined;
  exports: ExportInfo[];
  imports: string[];
  signatures: string[];
}
