import fs from "node:fs/promises";
import path from "node:path";

import {
  AIMEMORY_CONFIG_FILE,
  AiMemoryConfigSchema,
  DEFAULT_AI_MEMORY_CONFIG,
  type AiMemoryConfig
} from "../types/config.js";

export interface InitResult {
  path: string;
  written: boolean;
}
// creates default config unless it already exists and force is false.
export async function createDefaultConfig(
  targetDir: string,
  force = false
): Promise<InitResult> {
  const absoluteTarget = path.resolve(targetDir);
  const configPath = path.join(absoluteTarget, AIMEMORY_CONFIG_FILE);
  const nextConfig: AiMemoryConfig = AiMemoryConfigSchema.parse(
    DEFAULT_AI_MEMORY_CONFIG
  );

  try {
    await fs.access(configPath);
    if (!force) {
      return { path: configPath, written: false };
    }
  } catch {
    // file is missing, so continue with create path.
  }

  const content = `${JSON.stringify(nextConfig, null, 2)}\n`;
  await fs.mkdir(absoluteTarget, { recursive: true });
  await fs.writeFile(configPath, content, "utf8");
  return { path: configPath, written: true };
}
