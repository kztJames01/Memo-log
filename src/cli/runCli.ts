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
} from "../engine/index.js";

// CLI entry point for deterministic project memory generation
// Supports three main operations: init, commits, and scan
type ScanMode = "tech" | "simple" | "dual" | "brief";  // Different scanning strategies
const DEFAULT_SCAN_MODE: ScanMode = "dual";  // Default scanning mode
type ScanFormat = "md" | "json" | "both";  // Output formats for scan results

interface InitCommandOptions {
  force?: boolean;
}

interface RawScanCommandOptions {
  mode?: ScanMode;
  out?: string;
  format?: ScanFormat;
  config?: string | true;
  maxDepth?: number | true;
  timeoutMs?: number | true;
  maxFileSizeBytes?: number | true;
}

interface ScanExecutionOptions {
  targetDir: string;
  mode?: ScanMode | undefined;
  out?: string | undefined;
  format?: ScanFormat | undefined;
  config?: string | undefined;
  maxDepth?: number | undefined;
  timeoutMs?: number | undefined;
  maxFileSizeBytes?: number | undefined;
  includeAgentNotes?: boolean | undefined;
  quiet?: boolean | undefined;
}

interface ScanExecutionResult {
  markdownPath?: string | undefined;
  jsonPath?: string | undefined;
  warnings: string[];
  totalFiles: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;  // Type guard for Record type

//parser for non-negative integers in CLI arguments
const parseNonNegativeInteger = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError(`Expected a non-negative integer, received "${value}".`);
  }
  return parsed;
};

//parser for positive integers in CLI arguments
const parsePositiveInteger = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`Expected a positive integer, received "${value}".`);
  }
  return parsed;
};

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

const buildProgram = (): Command => {
  const program = new Command();

  program
    .name("ai-memory")
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
    .action(async (targetDir: string, options: { apply?: boolean; dryRun?: boolean }) => {
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
          const result = await git.commitFiles(group.files, msg);
          if (result.stdout.trim().length > 0) {
            console.log(`  committed: ${msg}`);
          } else {
            console.log(`  committed: ${msg}`);
          }
        }
      }

      if (dryRun) {
        console.log("\nDry-run mode. Re-run with --apply to execute commits.");
      }
    });

  program
    .command("scan")
    .argument("<targetDir>", "Directory to scan")
    .addOption(new Option("--mode <mode>").choices(["tech", "simple", "dual", "brief"]).default(DEFAULT_SCAN_MODE))
    .option("--out <path>", "Output file path (requires --format md or json)")
    .addOption(new Option("--format <format>").choices(["md", "json", "both"]).default("both"))
    .option("--config [path]", "Config file path override")
    .option("--max-depth [n]", "Maximum traversal depth", parseNonNegativeInteger)
    .option("--timeout-ms [n]", "Scan timeout in milliseconds", parsePositiveInteger)
    .option(
      "--max-file-size-bytes [n]",
      "Maximum file size in bytes",
      parsePositiveInteger,
    )
    .option("--quiet", "Suppress warnings")
    .option("--include-agent-notes", "Append agent session notes (marked unverified)")
    .action(async (targetDir: string, options: RawScanCommandOptions & { quiet?: boolean; includeAgentNotes?: boolean }) => {
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

      const maxDepth = normalizeOptional(options.maxDepth);
      if (maxDepth !== undefined) {
        scanOptions.maxDepth = maxDepth;
      }

      const timeoutMs = normalizeOptional(options.timeoutMs);
      if (timeoutMs !== undefined) {
        scanOptions.timeoutMs = timeoutMs;
      }

      const maxFileSizeBytes = normalizeOptional(options.maxFileSizeBytes);
      if (maxFileSizeBytes !== undefined) {
        scanOptions.maxFileSizeBytes = maxFileSizeBytes;
      }
      if (options.includeAgentNotes !== undefined) {
        scanOptions.includeAgentNotes = options.includeAgentNotes;
      }
      if (options.quiet !== undefined) {
        scanOptions.quiet = options.quiet;
      }

      const effectiveConfig = await loadEffectiveConfig(scanOptions);
      const result: ScanExecutionResult = await runScanCommand({ ...scanOptions, effectiveConfig });

      if (!options.quiet) {
        console.log(`Scanned ${result.totalFiles} files.`);
        if (result.markdownPath) {
          console.log(`Markdown: ${result.markdownPath}`);
        }
        if (result.jsonPath) {
          console.log(`JSON: ${result.jsonPath}`);
        }
      }
    });

  // Configure and return the CLI program with all commands and options
  return program;
};

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
