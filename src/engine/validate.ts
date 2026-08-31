import { readFileSync } from "node:fs";
import { validateOutput } from "./anti-hallucination.js";
import type { MemorySnapshot } from "./anti-hallucination.js";

export function validateMemoryJsonFile(filePath: string): MemorySnapshot {
  const raw = readFileSync(filePath, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`INVALID_JSON: cannot parse ${filePath}`);
  }
  return validateOutput(json, ".");
}
