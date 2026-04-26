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
}

export interface AstExtract {
  file: string;
  exports: ExportInfo[];
  imports: string[];
  signatures: string[];
}
