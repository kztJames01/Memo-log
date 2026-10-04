import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import {
  createDefaultConfig,
  loadEffectiveConfig,
  runScanCommand,
  CliError,
  ExitCode,
} from "../engine/index.js";
import type { AuditOptions } from "./audit.js";
import type { ParsedFile } from "../parsers/types.js";
import { formatScanHelp } from "./scanHelp.js";

// CLI entry point for deterministic project memory generation
// Supports three main operations: init, commits, and scan
type ScanMode = "tech" | "simple" | "dual" | "brief";  // Different scanning strategies
type ScanFormat = "md" | "json" | "both";  // Output formats for scan results

interface InitCommandOptions {
  force?: boolean;
}

interface RawScanCommandOptions {
  mode?: ScanMode;
  out?: string;
  format?: ScanFormat;
  config?: string | true;
}

interface ScanExecutionOptions {
  targetDir: string;
  mode?: ScanMode | undefined;
  out?: string | undefined;
  format?: ScanFormat | undefined;
  config?: string | undefined;
  includeAgentNotes?: boolean | undefined;
  quiet?: boolean | undefined;
  filter?: string | undefined;
}

interface ScanExecutionResult {
  markdownPath?: string | undefined;
  jsonPath?: string | undefined;
  warnings: string[];
  totalFiles: number;
}

interface CommitCommandOptions {
  apply?: boolean;
  dryRun?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;  // Type guard for Record type

const normalizeOptional = <T>(value: T | true | undefined): T | undefined =>
  value === true ? undefined : value;

// Convert errors to standardized exit codes for consistent CLI behavior
const toExitCode = (error: unknown): number => {
  if (error instanceof CommanderError) {
    if (
      error.code === "commander.helpDisplayed" || 
      error.code === "commander.version"  
    ) {
      return 0;  // Success exit code for non-error commands
    }
    return typeof error.exitCode === "number" ? error.exitCode : 1;
  }

  if (isRecord(error) && typeof error.exitCode === "number") {
    return error.exitCode; // Use exitCode if available on custom errors
  }

  return 1;  // Default error exit code
};

const printErrorIfNeeded = (error: unknown): void => {
  if (error instanceof CommanderError) {
    return;
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    console.error(error.message);
    return;
  }

  console.error("Command failed.");
};

const runCommitsCommand = async (
  targetDir: string,
  options: CommitCommandOptions,
): Promise<void> => {
  const GitService = await import("../engine/git.js").then(m => m.GitService);
  const CommitGrouper = await import("../engine/commit-grouper.js").then(m => m.CommitGrouper);

  const git = new GitService(targetDir);
  const changes = await git.getChangedFiles();

  if (changes.length === 0) {
    console.log("No changes detected since HEAD.");
    return;
  }

  const groups = CommitGrouper.groupChanges(changes);
  if (options.apply && options.dryRun) {
    throw new InvalidArgumentError("Use either --apply or --dry-run, not both.");
  }

  const apply = Boolean(options.apply);
  const dryRun = !apply;

  console.log("\nSuggested commit groups:\n");
  for (const group of groups) {
    const msg = CommitGrouper.generateMessage(group);
    const command = git.renderCommitCommand(group.files, msg);

    console.log(`- ${msg}`);
    console.log(`  files: ${group.files.join(", ")}`);
    console.log(`  cmd: ${command}`);

    if (!dryRun) {
      await git.commitFiles(group.files, msg);
      console.log(`  committed: ${msg}`);
    }
  }

  if (dryRun) {
    console.log("\nDry-run mode. Re-run with --apply to execute commits.");
  }
};

const buildProgram = (): Command => {
  const program = new Command();

  program
    .name("memo-log")
    .description("Deterministic project memory generator")
    .showHelpAfterError()
    .exitOverride();

  program
    .command("init")
    .argument("[targetDir]", "Directory to initialize", ".")
    .option("--force", "Overwrite existing config")
    .action(async (targetDir: string, options: InitCommandOptions) => {
      await createDefaultConfig(targetDir, Boolean(options.force));
    });

  program
    .command("commits")
    .argument("[targetDir]", "Directory to analyze", ".")
    .option("--dry-run", "Print commit commands without executing them")
    .option("--apply", "Automatically execute git commit commands")
    .action(runCommitsCommand);

  program
    .command("commit")
    .argument("[targetDir]", "Directory to analyze", ".")
    .option("--dry-run", "Print commit commands without executing them")
    .option("--apply", "Automatically execute git commit commands")
    .action(runCommitsCommand);

  program
    .command("scan")
    .argument("[targetDir]", "Directory to scan", ".")
    .description("Generate MEMO_LOG.md and MEMO_LOG.json")
    .configureHelp({
      formatHelp: () => formatScanHelp("happy"),
    })
    .addOption(new Option("-m, --mode <mode>").choices(["tech", "simple", "dual", "brief"]))
    .addOption(new Option("-f, --format <format>").choices(["md", "json", "both"]).default("both"))
    .option("-w, --watch", "Watch files and rescan (prompts once on first run)")
    .option("-q, --quiet", "Suppress warnings")
    .option("--help-advanced", "Show power-user flags")
    .option("--help-experimental", "Show experimental flags")
    .addOption(new Option("-o, --out <path>", "Override output path (needs --format md or json)").hideHelp())
    .addOption(new Option("-c, --config [path]", "Config file path override").hideHelp())
    .addOption(new Option("--include-agent-notes", "Append unverified agent notes").hideHelp())
    .addOption(new Option("--filter <level>", "Significance filter").choices(["trivial", "logic", "all"]).hideHelp())
    .addOption(new Option("--infer-runtime", "Static runtime inference").hideHelp())
    .addOption(new Option("--agent-ui", "Multi-agent conflict report").hideHelp())
    .addOption(new Option("--export-context", "Write MEMO_LOG_CONTEXT.json for LLM paste").hideHelp())
    .addOption(new Option("--confirm", "Script-only watch confirm (no TTY)").hideHelp())
    .addOption(new Option("--max-depth [n]").hideHelp())
    .addOption(new Option("--timeout-ms [n]").hideHelp())
    .addOption(new Option("--max-file-size-bytes [n]").hideHelp())
    .addOption(new Option("--track-types").hideHelp())
    .action(async (targetDir: string, options: RawScanCommandOptions & {
      quiet?: boolean;
      includeAgentNotes?: boolean;
      filter?: string;
      watch?: boolean;
      confirm?: boolean;
      inferRuntime?: boolean;
      agentUi?: boolean;
      exportContext?: boolean;
      helpAdvanced?: boolean;
      helpExperimental?: boolean;
      maxDepth?: unknown;
      timeoutMs?: unknown;
      maxFileSizeBytes?: unknown;
      trackTypes?: unknown;
    }) => {
      if (options.helpExperimental) {
        process.stdout.write(formatScanHelp("experimental"));
        return;
      }
      if (options.helpAdvanced) {
        process.stdout.write(formatScanHelp("advanced"));
        return;
      }
      if (options.maxDepth !== undefined || options.timeoutMs !== undefined || options.maxFileSizeBytes !== undefined || options.trackTypes) {
        throw new CliError(
          "maxDepth, timeoutMs, maxFileSizeBytes, and trackTypes belong in .memolog.json, not CLI flags.",
          ExitCode.ConfigError,
        );
      }

      const scanOptions: ScanExecutionOptions = { targetDir };
      if (options.mode !== undefined) {
        scanOptions.mode = options.mode;
      }
      if (options.out !== undefined) {
        scanOptions.out = options.out;
      }
      if (options.format !== undefined) {
        scanOptions.format = options.format;
      }

      const config = normalizeOptional(options.config);
      if (config !== undefined) {
        scanOptions.config = config;
      }
      if (options.includeAgentNotes !== undefined) {
        scanOptions.includeAgentNotes = options.includeAgentNotes;
      }
      if (options.quiet !== undefined) {
        scanOptions.quiet = options.quiet;
      }
      if (options.filter !== undefined) {
        scanOptions.filter = options.filter;
      }

      const effectiveConfig = await loadEffectiveConfig(scanOptions);
      const result: ScanExecutionResult = await runScanCommand({ ...scanOptions, effectiveConfig });

      if (options.inferRuntime) {
        await runRuntimeInference(targetDir);
      }

      if (options.agentUi) {
        await runAgentConflictDetection(targetDir, options.quiet ?? false);
      }

      if (options.exportContext) {
        const { writeExportContext } = await import("./exportContext.js");
        const jsonPath = result.jsonPath;
        const ctxPath = writeExportContext(effectiveConfig.rootDir, jsonPath);
        if (!options.quiet) {
          console.log(`Export context: ${ctxPath}`);
        }
      }

      if (!options.quiet) {
        console.log(`Scanned ${result.totalFiles} files.`);
        if (result.markdownPath) {
          console.log(`Markdown: ${result.markdownPath}`);
        }
        if (result.jsonPath) {
          console.log(`JSON: ${result.jsonPath}`);
        }
      }

      if (options.watch) {
        const { ensureWatchAllowed } = await import("../engine/watchConfirm.js");
        await ensureWatchAllowed(effectiveConfig.rootDir, options.confirm === true);

        const { startWatcher } = await import("../engine/watcher.js");
        const sigOptions = {
          filter: (scanOptions.filter as "trivial" | "logic" | "all") ?? effectiveConfig.config.filter ?? "logic",
          trackTypes: effectiveConfig.config.trackTypes ?? false,
        };
        const controller = startWatcher({
          rootDir: effectiveConfig.rootDir,
          config: effectiveConfig,
          sigOptions,
          quiet: options.quiet ?? false,
        });

        const shutdown = async () => {
          await controller.stop();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);

        await new Promise<void>(() => {});
      }
    });

  // Phase 4: audit command — deterministic, Zod-validated, hash-signed export
  program
    .command("audit")
    .argument("[targetDir]", "Directory to audit", ".")
    .addOption(new Option("--format <format>", "Output format").choices(["json", "text"]).default("json"))
    .option("--out <path>", "Write output to file instead of stdout")
    .action(async (targetDir: string, options: { format: "json" | "text"; out?: string }) => {
      const { runAuditCommand } = await import("./audit.js");
      const auditOpts: AuditOptions = { targetDir, format: options.format };
      if (options.out !== undefined) auditOpts.out = options.out;
      await runAuditCommand(auditOpts);
    });

  program
    .command("validate")
    .argument("[file]", "MEMO_LOG.json path to schema-check", "MEMO_LOG.json")
    .action(async (file: string) => {
      const { validateMemoryJsonFile } = await import("../engine/validate.js");
      const snapshot = validateMemoryJsonFile(file);
      process.stdout.write(`OK schema v${snapshot.version} entries=${snapshot.entries.length}\n`);
    });

  return program;
};

async function runRuntimeInference(targetDir: string): Promise<void> {
  const { inferBatch, renderInferenceMarkdown } = await import("../engine/runtimeInference.js");
  const { parseFile } = await import("../parsers/index.js");
  const { assertPathWithinRoot, normalizeRelativePath, resolveSecureRoot } = await import("../security/pathGuards.js");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { randomUUID } = await import("node:crypto");

  const absoluteTarget = path.resolve(targetDir);
  const secureRoot = await resolveSecureRoot(absoluteTarget);
  const jsonPath = path.join(secureRoot, "MEMO_LOG.json");
  const filePaths: string[] = [];
  try {
    const raw = await fs.readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { entries?: Array<{ ref: string }> };
    const refs = parsed.entries ?? [];
    const seen = new Set<string>();
    for (const entry of refs) {
      const m = entry.ref.match(/^\[(.+?):\d+/);
      if (!m?.[1]) continue;
      let rel = "";
      try {
        rel = normalizeRelativePath(m[1]);
        if (!rel || rel.includes("..")) continue;
      } catch {
        continue;
      }
      const fp = path.resolve(secureRoot, rel);
      try {
        assertPathWithinRoot(secureRoot, fp);
      } catch {
        continue;
      }
      if (!seen.has(fp)) {
        seen.add(fp);
        filePaths.push(fp);
      }
    }
  } catch {
    console.warn("WARN: --infer-runtime: could not read MEMO_LOG.json. Run scan first.");
    return;
  }

  const maxInferenceFiles = 50;
  if (filePaths.length > maxInferenceFiles) {
    console.warn(`WARN: INFERENCE_FILE_CAP_APPLIED — omitted ${filePaths.length - maxInferenceFiles} file(s) beyond first ${maxInferenceFiles}.`);
  }

  const pairs: Array<{ parsed: ParsedFile; content: string }> = [];
  for (const fp of filePaths.slice(0, maxInferenceFiles)) {
    try {
      const rel = path.relative(secureRoot, fp);
      const content = await fs.readFile(fp, "utf8");
      const sizeBuf = Buffer.byteLength(content, "utf8");
      const parsed = await parseFile(rel, content, sizeBuf);
      pairs.push({ parsed, content });
    } catch { /* skip unreadable files */ }
  }

  const results = inferBatch(pairs, { timeoutMs: 2000 });
  const md = renderInferenceMarkdown(results);
  const outPath = path.join(secureRoot, "MEMO_LOG_INFERENCE.md");
  const tmpPath = `${outPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, md, "utf8");
    await fs.rename(tmpPath, outPath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
  console.log(`Runtime inference written to: ${outPath}`);
}

async function runAgentConflictDetection(targetDir: string, quiet: boolean): Promise<void> {
  const path = await import("node:path");
  const { runAgentUiWorkflow } = await import("../engine/agentUi.js");

  const absoluteTarget = path.resolve(targetDir);
  const result = await runAgentUiWorkflow(absoluteTarget);

  if (!quiet) {
    for (const warning of result.warnings) {
      console.warn(warning);
    }
    if (!result.previousSnapshotFound) {
      console.log("Agent UI baseline snapshot created. Re-run with --agent-ui after the next scan to detect conflicts.");
      return;
    }
    console.log(`Conflict report written to: ${result.reportPath}`);
    if (result.report === null) {
      console.warn("⚠ Conflict comparison skipped. See warnings above and MEMO_LOG_CONFLICTS.md");
    } else if (result.report.totalConflicts > 0) {
      console.warn(`⚠ ${result.report.totalConflicts} conflict(s) detected. Review MEMO_LOG_CONFLICTS.md`);
    } else {
      console.log("No conflicts detected.");
    }
  }
}

// Entry point for running the CLI
export const runCli = async (argv?: string[]): Promise<number> => {
  const program = buildProgram();

  try {
    const args = argv ?? process.argv.slice(2);  // Use provided args or process arguments
    await program.parseAsync(args, { from: "user" });  // Parse and execute commands
    return 0;  // Success exit code
  } catch (error: unknown) {
    const exitCode = toExitCode(error);  // Convert error to exit code
    if (exitCode !== 0) {
      printErrorIfNeeded(error);  // Print error message if needed
    }
    return exitCode;  // Return appropriate exit code
  }
};
