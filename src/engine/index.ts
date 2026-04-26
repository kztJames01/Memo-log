import {
  loadAiMemoryConfig,
  loadEffectiveConfig as loadEffectiveConfigFromConfig,
  type LoadedAiMemoryConfig,
  type LoadAiMemoryConfigOptions,
  type LoadEffectiveConfigOptions
} from "./config.js";
import { createDefaultConfig, type InitResult } from "./init.js";
import {
  runScanCommand,
  runStructuralScan,
  type OutputFormat,
  type RunScanCommandInput,
  type RunScanCommandResult,
  type ScanExecutionOptions
} from "./scan.js";
import { CliError, ExitCode } from "./errors.js";
import type { AstExtract, StructuralScanOptions } from "../types/scan.js";
import {
  diffStates,
  buildCurrentState,
  loadState,
  saveState,
  renderRecentChanges,
  appendRecentChanges,
  validateNoStaleReferences,
  writeStateAtomic,
  clearState,
  getDiffSummary,
  type DiffResult,
  type FileDiff,
  type ChangeType,
  type FileState,
  STATE_DIR
} from "./diff.js";

export type { AstExtract, StructuralScanOptions };
export type { DiffResult, FileDiff, ChangeType, FileState };
// narrows cli options to the config loader contract.
export function loadEffectiveConfig(
  options: ScanExecutionOptions
): LoadedAiMemoryConfig {
  const effectiveOptions: LoadEffectiveConfigOptions = {
    targetDir: options.targetDir
  };
  if (options.config !== undefined) {
    effectiveOptions.config = options.config;
  }
  if (options.mode === "tech" || options.mode === "simple") {
    effectiveOptions.mode = options.mode;
  }
  if (options.maxDepth !== undefined) {
    effectiveOptions.maxDepth = options.maxDepth;
  }

  return loadEffectiveConfigFromConfig(effectiveOptions);
}

export {
  CliError,
  ExitCode,
  createDefaultConfig,
  loadAiMemoryConfig,
  runScanCommand,
  runStructuralScan,
  diffStates,
  buildCurrentState,
  loadState,
  saveState,
  renderRecentChanges,
  appendRecentChanges,
  validateNoStaleReferences,
  writeStateAtomic,
  clearState,
  getDiffSummary,
  STATE_DIR
};

export type {
  InitResult,
  LoadedAiMemoryConfig,
  LoadAiMemoryConfigOptions,
  LoadEffectiveConfigOptions,
  OutputFormat,
  RunScanCommandInput,
  RunScanCommandResult,
  ScanExecutionOptions
};
