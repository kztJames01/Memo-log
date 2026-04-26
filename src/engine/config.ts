// loads, merges, and validates config from defaults, file, and cli overrides.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import {
  AIMEMORY_CONFIG_FILE,
  AiMemoryConfigOverridesSchema,
  AiMemoryConfigSchema,
  type AiMemoryConfig,
  type AiMemoryConfigOverrides,
  type AiMemoryMode,
  DEFAULT_AI_MEMORY_CONFIG,
  normalizeAiMemoryConfig
} from "../types/index.js";
import { ExitCode } from "./errors.js";

export type ConfigLoadErrorCode =
  | "INVALID_ROOT"
  | "INVALID_JSON"
  | "INVALID_CONFIG"
  | "INVALID_OUTPUT_PATH";

export class ConfigLoadError extends Error {
  public readonly code: ConfigLoadErrorCode;
  public readonly configPath: string | undefined;
  public readonly exitCode = ExitCode.ConfigError;

  public constructor(
    code: ConfigLoadErrorCode,
    message: string,
    configPath?: string
  ) {
    super(message);
    this.name = "ConfigLoadError";
    this.code = code;
    this.configPath = configPath;
  }
}

export interface LoadAiMemoryConfigOptions {
  targetDir: string;
  configFileName?: string | undefined;
  configPath?: string | undefined;
  overrides?: AiMemoryConfigOverrides | undefined;
}

export interface LoadedAiMemoryConfig {
  rootDir: string;
  configPath: string;
  loadedFromFile: boolean;
  config: AiMemoryConfig;
}

export interface LoadEffectiveConfigOptions {
  targetDir: string;
  config?: string | undefined;
  mode?: AiMemoryMode | undefined;
  maxDepth?: number | undefined;
}

export function loadEffectiveConfig(
  options: LoadEffectiveConfigOptions
): LoadedAiMemoryConfig {
  const overrides: AiMemoryConfigOverrides = {};
  if (options.mode !== undefined) {
    overrides.mode = options.mode;
  }
  if (options.maxDepth !== undefined) {
    overrides.maxDepth = options.maxDepth;
  }

  const loadOptions: LoadAiMemoryConfigOptions = {
    targetDir: options.targetDir,
    overrides
  };
  if (options.config !== undefined) {
    loadOptions.configPath = options.config;
  }

  return loadAiMemoryConfig(loadOptions);
}

export function loadAiMemoryConfig(
  options: LoadAiMemoryConfigOptions
): LoadedAiMemoryConfig {
  const rootDir = resolveRootDir(options.targetDir);
  const configPath = resolveConfigPath(
    rootDir,
    options.configPath,
    options.configFileName
  );

  const fileLayer = readConfigFileLayer(configPath, Boolean(options.configPath));
  const overrideLayer = parseConfigLayer(
    options.overrides ?? {},
    "CLI overrides",
    configPath
  );

  const merged = mergeConfigLayers(
    DEFAULT_AI_MEMORY_CONFIG,
    fileLayer.config,
    overrideLayer
  );

  let normalized: AiMemoryConfig;
  try {
    normalized = normalizeAiMemoryConfig(merged, rootDir);
  } catch (error) {
    throw new ConfigLoadError(
      "INVALID_OUTPUT_PATH",
      error instanceof Error ? error.message : "Invalid output path",
      configPath
    );
  }

  const validated = parseFinalConfig(normalized, configPath);

  return {
    rootDir,
    configPath,
    loadedFromFile: fileLayer.loadedFromFile,
    config: validated
  };
}

function resolveRootDir(targetDir: string): string {
  const absolute = path.resolve(targetDir);
  try {
    return realpathSync(absolute);
  } catch (error) {
    throw new ConfigLoadError(
      "INVALID_ROOT",
      `Unable to resolve targetDir "${targetDir}": ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }
}

function resolveConfigPath(
  rootDir: string,
  explicitConfigPath: string | undefined,
  configFileName: string | undefined
): string {
  if (explicitConfigPath) {
    return path.resolve(process.cwd(), explicitConfigPath);
  }

  return path.join(rootDir, configFileName ?? AIMEMORY_CONFIG_FILE);
}

function readConfigFileLayer(
  configPath: string,
  explicitPathProvided: boolean
): {
  loadedFromFile: boolean;
  config: AiMemoryConfigOverrides;
} {
  if (!existsSync(configPath)) {
    if (explicitPathProvided) {
      throw new ConfigLoadError(
        "INVALID_CONFIG",
        `Config file not found: ${configPath}`,
        configPath
      );
    }

    return { loadedFromFile: false, config: {} };
  }

  let parsedJson: unknown;
  try {
    const content = readFileSync(configPath, "utf8");
    parsedJson = JSON.parse(content);
  } catch (error) {
    throw new ConfigLoadError(
      "INVALID_JSON",
      `Invalid JSON in "${configPath}": ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      configPath
    );
  }

  return {
    loadedFromFile: true,
    config: parseConfigLayer(parsedJson, "Config file", configPath)
  };
}

function parseConfigLayer(
  input: unknown,
  source: string,
  configPath: string
): AiMemoryConfigOverrides {
  try {
    return AiMemoryConfigOverridesSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigLoadError(
        "INVALID_CONFIG",
        `${source} validation failed: ${formatZodError(error)}`,
        configPath
      );
    }
    throw error;
  }
}

function parseFinalConfig(input: unknown, configPath: string): AiMemoryConfig {
  try {
    return AiMemoryConfigSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigLoadError(
        "INVALID_CONFIG",
        `Final configuration validation failed: ${formatZodError(error)}`,
        configPath
      );
    }
    throw error;
  }
}

function mergeConfigLayers(
  defaults: AiMemoryConfig,
  fileConfig: AiMemoryConfigOverrides,
  overrideConfig: AiMemoryConfigOverrides
): AiMemoryConfig {
  return {
    languages: [
      ...(overrideConfig.languages ??
        fileConfig.languages ??
        defaults.languages)
    ],
    exclude: [...(overrideConfig.exclude ?? fileConfig.exclude ?? defaults.exclude)],
    output: {
      markdown:
        overrideConfig.output?.markdown ??
        fileConfig.output?.markdown ??
        defaults.output.markdown,
      json:
        overrideConfig.output?.json ??
        fileConfig.output?.json ??
        defaults.output.json
    },
    maxDepth:
      overrideConfig.maxDepth ?? fileConfig.maxDepth ?? defaults.maxDepth,
    mode: overrideConfig.mode ?? fileConfig.mode ?? defaults.mode
  };
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const pathText = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${pathText}: ${issue.message}`;
    })
    .join("; ");
}
