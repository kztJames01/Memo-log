import * as vscode from "vscode";
import * as path from "path";

// reads .memolog.json to get custom output paths, falls back to defaults.
// keyed by workspace root so multi-root windows do not share one cache entry.
const pathCache = new Map<string, { md: string; json: string }>();

const DEFAULT_MD = "MEMO_LOG.md";
const DEFAULT_JSON = "MEMO_LOG.json";

export function getDefaults() {
  return { md: DEFAULT_MD, json: DEFAULT_JSON };
}

export async function getMemoryPaths(rootUri: vscode.Uri): Promise<{ md: string; json: string }> {
  const cacheKey = rootUri.toString();
  const cached = pathCache.get(cacheKey);
  if (cached) return cached;

  try {
    const configUri = vscode.Uri.joinPath(rootUri, ".memolog.json");
    const buf = await vscode.workspace.fs.readFile(configUri);
    const parsed = JSON.parse(new TextDecoder("utf-8").decode(buf)) as Record<string, unknown>;

    const output = parsed["output"] as Record<string, unknown> | undefined;
    let md = DEFAULT_MD;
    let json = DEFAULT_JSON;

    if (output) {
      if (typeof output["markdown"] === "string" && output["markdown"].trim()) {
        const resolved = path.posix.normalize(output["markdown"]);
        // don't allow escaping workspace
        if (!resolved.startsWith("..") && !path.isAbsolute(resolved)) {
          md = resolved;
        }
      }
      if (typeof output["json"] === "string" && output["json"].trim()) {
        const resolved = path.posix.normalize(output["json"]);
        if (!resolved.startsWith("..") && !path.isAbsolute(resolved)) {
          json = resolved;
        }
      }
    }

    const resolved = { md, json };
    pathCache.set(cacheKey, resolved);
    return resolved;
  } catch {
    // no config file or bad json, just use defaults
    const defaults = { md: DEFAULT_MD, json: DEFAULT_JSON };
    pathCache.set(cacheKey, defaults);
    return defaults;
  }
}

// clear cache when config changes
export function clearPathCache(): void {
  pathCache.clear();
}
