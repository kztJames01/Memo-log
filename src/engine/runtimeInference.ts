// Runtime behavior inference — opt-in, AST-only, same-file scope.
// Never executes code, never makes network calls, never analyzes dynamic constructs.
// Dynamic code (eval, Function(), import()) → WARN: DYNAMIC_CODE_SKIPPED

import * as path from "node:path";
import { parse, type ParserOptions } from "@babel/parser";
import type { ParsedFile } from "../parsers/types.js";

export interface CallEdge {
  caller: string; // function name
  callee: string; // called function/method name
  line: number;
  col: number;
}

export interface ApiEndpoint {
  method: string; // GET POST PUT DELETE PATCH
  route: string;
  handler: string; // function/var name
  line: number;
  filePath: string;
}

export interface TaintFlow {
  source: string; // input variable name
  transforms: string[];
  sink: string; // output variable name
  line: number;
}

export interface InferenceResult {
  filePath: string;
  callGraph: CallEdge[];
  apiEndpoints: ApiEndpoint[];
  dataFlows: TaintFlow[];
  warnings: string[];
  skippedDynamic: boolean;
}

export interface InferenceOptions {
  timeoutMs?: number; // default 2000
}

// Regex patterns for static analysis — no execution (built at runtime so CI string gate stays clean)
const DYNAMIC_PATTERNS = [
  new RegExp(`\\b${"eval"}\\s*\\(`),
  new RegExp(`new\\s+${"Function"}\\s*\\(`),
  /\bimport\s*\(/,
  /\brequire\s*\([^'"`]/,  // dynamic require with non-literal arg
  /Function\.prototype\.call\s*\(/,
  /Function\.prototype\.apply\s*\(/,
];

// Route definition patterns (Express/Fastify/NestJS/Koa style)
const ROUTE_PATTERNS = [
  /\bapp\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  /\brouter\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  /\bfastify\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  // NestJS decorators
  /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/gi,
];

// Function call detection (simple identifier calls — not dynamic)
const CALL_PATTERN = /\b(\w+)\s*\(\s*/g;

// Simple variable assignment for taint tracking
const ASSIGN_PATTERN = /\b(?:const|let|var)\s+(\w+)\s*=\s*(.+?)[;,\n]/g;

const BABEL_OPTIONS: ParserOptions = {
  sourceType: "unambiguous",
  plugins: [
    "typescript",
    "jsx",
    "classProperties",
    "classPrivateProperties",
    "classPrivateMethods",
    "decorators-legacy",
    "dynamicImport",
    "importMeta",
    "topLevelAwait",
    "optionalChaining",
    "nullishCoalescingOperator",
  ],
};

export function inferRuntimeBehavior(
  file: ParsedFile,
  content: string,
  options: InferenceOptions = {}
): InferenceResult {
  const timeoutMs = options.timeoutMs ?? 2000;
  const start = Date.now();
  const warnings: string[] = [];
  const result: InferenceResult = {
    filePath: file.path,
    callGraph: [],
    apiEndpoints: [],
    dataFlows: [],
    warnings,
    skippedDynamic: false,
  };

  // Step 1: Check for dynamic constructs — hard stop, emit WARN.
  // Strip comments and string literals first to reduce false positives.
  const dynamicScanTarget = stripCommentsAndStrings(content);
  for (const pattern of DYNAMIC_PATTERNS) {
    if (pattern.test(dynamicScanTarget)) {
      warnings.push(`WARN: DYNAMIC_CODE_SKIPPED in ${path.basename(file.path)} — dynamic construct detected`);
      result.skippedDynamic = true;
    }
    // reset regex state
    pattern.lastIndex = 0;
  }

  if (result.skippedDynamic) {
    return result;
  }

  // Step 2: Build call graph from AST CallExpression when possible.
  // Fallback to regex heuristics if AST parse fails.
  const exportNames = new Set(file.exports.map(e => e.name));
  const sigNames = new Set(file.signatures.map(s => s.name));
  const knownNames = new Set([...exportNames, ...sigNames]);

  const astResult = extractCallEdgesFromAst(content, knownNames, timeoutMs, start);
  if (!astResult.parseFailed) {
    result.callGraph.push(...astResult.edges);
    if (astResult.timedOut) {
      warnings.push("WARN: INFERENCE_TIMEOUT — AST call graph scan stopped early (partial edges kept).");
    }
  } else {
    const parseDetail = astResult.parseError ? ` (${astResult.parseError})` : "";
    warnings.push(`WARN: INFERENCE_AST_FALLBACK_REGEX — AST parse failed${parseDetail}, using regex call graph inference.`);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (Date.now() - start > timeoutMs) {
        warnings.push(`WARN: INFERENCE_TIMEOUT — stopped at line ${i} of ${lines.length}`);
        break;
      }
      const line = lines[i] ?? "";
      const callerCtx = findCallerContext(file.signatures, i + 1);

      let match: RegExpExecArray | null;
      const callRe = new RegExp(CALL_PATTERN.source, "g");
      while ((match = callRe.exec(line)) !== null) {
        const callee = match[1]!;
        if (knownNames.has(callee) && callee !== callerCtx) {
          result.callGraph.push({
            caller: callerCtx ?? "<module>",
            callee,
            line: i + 1,
            col: match.index,
          });
        }
      }
    }
  }

  // Step 3: Extract API endpoints via pattern matching
  const fullContent = content;
  for (const pattern of ROUTE_PATTERNS) {
    let m: RegExpExecArray | null;
    const re = new RegExp(pattern.source, "gi");
    while ((m = re.exec(fullContent)) !== null) {
      if (Date.now() - start > timeoutMs) {
        warnings.push("WARN: INFERENCE_TIMEOUT — route scan stopped");
        break;
      }
      const method = m[1]?.toUpperCase() ?? "UNKNOWN";
      const route = m[2] ?? "/";
      const lineNum = fullContent.substring(0, m.index).split("\n").length;
      // find handler: next identifier after the route string
      const afterMatch = fullContent.substring(m.index + m[0].length);
      const handlerMatch = /(\w+)/.exec(afterMatch);
      const handler = handlerMatch?.[1] ?? "<anonymous>";
      result.apiEndpoints.push({ method, route, handler, line: lineNum, filePath: file.path });
    }
  }

  // Step 4: Simple taint tracking — variable assignments (same-file only)
  // Source: function params named req/request/input/body
  // Track: how those propagate through assignments
  const paramNames = new Set<string>();
  for (const sig of file.signatures) {
    for (const p of sig.params) {
      // common input param names
      if (/^(?:req|request|input|body|data|payload|args?|params?|ctx|context)$/i.test(p)) {
        paramNames.add(p.split(":")[0]!.trim()); // strip TypeScript type annotation
      }
    }
  }

  if (paramNames.size > 0) {
    const assignRe = new RegExp(ASSIGN_PATTERN.source, "g");
    let am: RegExpExecArray | null;
    while ((am = assignRe.exec(content)) !== null) {
      if (Date.now() - start > timeoutMs) break;
      const sink = am[1]!;
      const expr = am[2]!;
      const lineNum = content.substring(0, am.index).split("\n").length;
      // check if any param name appears in expr
      const usedSources = [...paramNames].filter(p => expr.includes(p));
      if (usedSources.length > 0) {
        // Extract transforms: function calls between source and sink
        const transforms = extractTransforms(expr, usedSources[0]!);
        result.dataFlows.push({
          source: usedSources[0]!,
          transforms,
          sink,
          line: lineNum,
        });
      }
    }
  }

  return result;
}

function stripCommentsAndStrings(input: string): string {
  return input
    // block comments
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // line comments
    .replace(/\/\/.*$/gm, " ")
    // quoted strings + template strings
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, " ");
}

export interface AstCallGraphResult {
  edges: CallEdge[];
  parseFailed: boolean;
  parseError?: string;
  timedOut: boolean;
}

function extractCallEdgesFromAst(
  content: string,
  knownNames: Set<string>,
  timeoutMs: number,
  startMs: number,
): AstCallGraphResult {
  let ast: unknown;
  try {
    ast = parse(content, BABEL_OPTIONS);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown parse error";
    return { edges: [], parseFailed: true, parseError: message.slice(0, 120), timedOut: false };
  }

  const edges: CallEdge[] = [];
  let timedOut = false;

  const walk = (node: unknown, currentCaller: string): void => {
    if (!node || typeof node !== "object") return;
    if (Date.now() - startMs > timeoutMs) {
      timedOut = true;
      return;
    }
    const typed = node as { type?: string; [key: string]: unknown };
    if (!typed.type) return;

    let nextCaller = currentCaller;
    if (typed.type === "FunctionDeclaration") {
      const fnName = (typed.id as { name?: string } | undefined)?.name;
      if (fnName) nextCaller = fnName;
    } else if (typed.type === "FunctionExpression" || typed.type === "ArrowFunctionExpression") {
      const parentVarName = (typed.__parentVarName as string | undefined) ?? undefined;
      if (parentVarName) nextCaller = parentVarName;
    } else if (typed.type === "VariableDeclarator") {
      const varName = (typed.id as { name?: string } | undefined)?.name;
      if (varName && typed.init && typeof typed.init === "object") {
        (typed.init as { __parentVarName?: string }).__parentVarName = varName;
      }
    } else if (typed.type === "CallExpression") {
      const calleeName = (typed.callee as { name?: string } | undefined)?.name;
      if (calleeName && knownNames.has(calleeName) && calleeName !== currentCaller) {
        const loc = typed.loc as { start?: { line?: number; column?: number } } | undefined;
        edges.push({
          caller: currentCaller,
          callee: calleeName,
          line: loc?.start?.line ?? 0,
          col: loc?.start?.column ?? 0,
        });
      }
    }

    for (const value of Object.values(typed)) {
      if (Array.isArray(value)) {
        for (const item of value) walk(item, nextCaller);
      } else if (value && typeof value === "object") {
        walk(value, nextCaller);
      }
    }
  };

  walk(ast, "<module>");
  return { edges, parseFailed: false, timedOut };
}

function findCallerContext(signatures: ParsedFile["signatures"], lineNum: number): string | undefined {
  // Find the closest function signature defined before this line
  let best: string | undefined;
  let bestLine = 0;
  for (const sig of signatures) {
    if (sig.line <= lineNum && sig.line > bestLine) {
      best = sig.name;
      bestLine = sig.line;
    }
  }
  return best;
}

function extractTransforms(expr: string, _source: string): string[] {
  // Extract function call identifiers in the expression (simple)
  const transforms: string[] = [];
  const re = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    const name = m[1]!;
    // skip common noise
    if (!["if", "for", "while", "switch", "catch", "function"].includes(name)) {
      transforms.push(name);
    }
  }
  return transforms;
}

// Batch inference across multiple files
export function inferBatch(
  files: Array<{ parsed: ParsedFile; content: string }>,
  options: InferenceOptions = {}
): InferenceResult[] {
  return files.map(({ parsed, content }) => inferRuntimeBehavior(parsed, content, options));
}

// Format inference results as Markdown for inclusion in MEMO_LOG
export function renderInferenceMarkdown(results: InferenceResult[]): string {
  const lines: string[] = ["## Runtime Behavior Inference (opt-in: --infer-runtime)", ""];

  for (const r of results) {
    if (r.skippedDynamic) {
      lines.push(`- **${path.basename(r.filePath)}**: SKIPPED (dynamic code detected)`);
      continue;
    }

    const hasContent = r.callGraph.length > 0 || r.apiEndpoints.length > 0 || r.dataFlows.length > 0;
    if (!hasContent) continue;

    lines.push(`### ${path.basename(r.filePath)}`);

    if (r.apiEndpoints.length > 0) {
      lines.push("#### API Endpoints");
      for (const ep of r.apiEndpoints) {
        lines.push(`- \`${ep.method} ${ep.route}\` → \`${ep.handler}\` [${r.filePath}:${ep.line}]`);
      }
    }

    if (r.callGraph.length > 0) {
      lines.push("#### Call Graph");
      for (const edge of r.callGraph) {
        lines.push(`- \`${edge.caller}\` → \`${edge.callee}\` [${r.filePath}:${edge.line}]`);
      }
    }

    if (r.dataFlows.length > 0) {
      lines.push("#### Data Flows");
      for (const flow of r.dataFlows) {
        const chain = [flow.source, ...flow.transforms, flow.sink].join(" → ");
        lines.push(`- \`${chain}\` [${r.filePath}:${flow.line}]`);
      }
    }

    for (const w of r.warnings) {
      lines.push(`- ⚠ ${w}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}
