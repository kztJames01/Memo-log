// babel-based js/ts parser plugin.
import { parse, type ParserOptions } from "@babel/parser";
import type {
  BabelAst,
  Export,
  ExportKind,
  ExtractionResult,
  Import,
  JsDocBlock,
  ParserPlugin,
  ParseResult,
  Signature,
} from "./types.js";

// file extensions handled by this parser.
const SUPPORTED_EXTENSIONS = [".js", ".ts", ".jsx", ".tsx"] as const;

// strict parser options with error recovery.
const BABEL_OPTIONS: ParserOptions = {
  sourceType: "module" as const,
  plugins: [
    "typescript",
    "jsx",
    "classProperties",
    "objectRestSpread",
    "exportDefaultFrom",
    "exportNamespaceFrom",
  ],
  errorRecovery: true,
  allowUndeclaredExports: false,
};

// maps babel node type to our export kind.
function getExportKind(
  node: { type: string },
  _defaultName: string
): ExportKind {
  switch (node.type) {
    case "FunctionDeclaration":
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return "function";
    case "ClassDeclaration":
      return "class";
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
      return "type";
    case "ExportDefaultDeclaration":
      return "default";
    case "VariableDeclaration":
      return "const";
    default:
      return "const";
  }
}

// returns 1-based line and 0-based column.
function getLocation(node: { loc?: { start: { line: number; column: number } } }): {
  line: number;
  column: number;
} {
  if (node.loc?.start) {
    return {
      line: node.loc.start.line,
      column: node.loc.start.column,
    };
  }
  return { line: 1, column: 0 };
}

// reads jsdoc block above a declaration line.
function extractJsDoc(
  content: string,
  line: number
): JsDocBlock | undefined {
  const lines = content.split("\n");
  if (line < 2) return undefined;

  let cursor = line - 2;
  while (cursor >= 0 && (lines[cursor]?.trim() ?? "") === "") {
    cursor--;
  }

  if (cursor < 0 || !(lines[cursor] ?? "").includes("*/")) {
    return undefined;
  }

  const jsdocLines: string[] = [];
  let foundStart = false;
  for (; cursor >= 0; cursor--) {
    const currentLine = lines[cursor] ?? "";
    jsdocLines.unshift(currentLine);
    if (currentLine.includes("/**")) {
      foundStart = true;
      break;
    }
  }
  if (!foundStart) {
    return undefined;
  }

  let description: string | undefined;
  const params: Record<string, string> = {};
  let returns: string | undefined;

  for (const rawLine of jsdocLines) {
    const cleaned = rawLine
      .replace(/^\s*\/\*\*?/, "")
      .replace(/\*\/\s*$/, "")
      .replace(/^\s*\*\s?/, "")
      .trim();
    if (!cleaned) {
      continue;
    }

    if (cleaned.startsWith("@param")) {
      const match = cleaned.match(/^@param\s+(?:\{[^}]+\}\s+)?(?:\[[^\]]+\]\s+)?(\w+)(?:\s+-\s+)?(.*)$/);
      if (match?.[1]) {
        params[match[1]] = (match[2] ?? "").trim();
      }
      continue;
    }

    if (cleaned.startsWith("@returns") || cleaned.startsWith("@return")) {
      const match = cleaned.match(/^@(?:returns?|return)\s+(.+)$/);
      if (match?.[1]) {
        returns = match[1].trim();
      }
      continue;
    }

    if (cleaned.startsWith("@")) {
      continue;
    }

    if (!description) {
      description = cleaned;
    }
  }

  if (!description && Object.keys(params).length === 0 && !returns) {
    return undefined;
  }

  return {
    description,
    params: Object.keys(params).length > 0 ? params : undefined,
    returns,
  };
}

// extracts export symbols from the module body.
function extractExports(
  body: unknown[],
  content: string
): Export[] {
  const exports: Export[] = [];

  for (const node of body) {
    if (!node || typeof node !== "object") continue;

    const babelNode = node as {
      type: string;
      loc?: { start: { line: number; column: number } };
      declaration?: unknown;
      specifiers?: unknown[];
      source?: { value: string };
      default?: boolean;
    };

    const loc = getLocation(babelNode);

    switch (babelNode.type) {
      case "ExportNamedDeclaration": {
        if (babelNode.declaration) {
          // handles direct exported declarations.
          const decl = babelNode.declaration as {
            type: string;
            id?: { name: string };
            declarations?: unknown[];
            loc?: { start: { line: number; column: number } };
          };
          
          let name: string;
          let declLoc: { line: number; column: number };

          if (decl.type === "VariableDeclaration" && decl.declarations?.length) {
            // for variable exports, use first declarator location.
            const firstDecl = decl.declarations[0] as { id?: { name: string }; loc?: { start: { line: number; column: number } } };
            name = firstDecl.id?.name || "unknown";
            declLoc = firstDecl.loc?.start 
              ? { line: firstDecl.loc.start.line, column: firstDecl.loc.start.column }
              : getLocation(decl);
          } else {
            name = decl.id?.name || "anonymous";
            declLoc = decl.loc?.start
              ? { line: decl.loc.start.line, column: decl.loc.start.column }
              : getLocation(decl);
          }

          exports.push({
            name,
            kind: getExportKind(decl, name),
            line: declLoc.line,
            column: declLoc.column,
            jsdoc: extractJsDoc(content, declLoc.line)?.description,
          });
        }

        if (babelNode.specifiers?.length) {
          // handles export specifier list.
          for (const spec of babelNode.specifiers) {
            const specifier = spec as {
              type: string;
              local: { name: string };
              exported: { name: string };
              loc?: { start: { line: number; column: number } };
            };
            exports.push({
              name: specifier.exported?.name || specifier.local?.name || "unknown",
              kind: "const",
              line: getLocation(specifier).line,
              column: getLocation(specifier).column,
            });
          }
        }
        break;
      }

      case "ExportDefaultDeclaration": {
        // handles default export declaration.
        const decl = babelNode.declaration as {
          type: string;
          id?: { name: string };
          loc?: { start: { line: number; column: number } };
        };
        const name = decl?.id?.name || "default";
        const declLoc = getLocation(decl);

        exports.push({
          name,
          kind: "default",
          line: declLoc.line,
          column: declLoc.column,
          jsdoc: extractJsDoc(content, declLoc.line)?.description,
        });
        break;
      }

      case "ExportAllDeclaration": {
        exports.push({
          name: babelNode.source?.value || "*",
          kind: "default",
          line: loc.line,
          column: loc.column,
        });
        break;
      }

      default: {
        // skip unsupported export nodes.
        break;
      }
    }
  }

  return exports;
}

// extracts imports and groups names by path.
function extractImports(
  body: unknown[]
): Import[] {
  const imports: Import[] = [];
  
  // group names so one import path creates one record.
  const pathGroups = new Map<string, { names: string[]; line: number; column: number; importKind: "value" | "type" | "dynamic" }>();

  for (const node of body) {
    if (!node || typeof node !== "object") continue;

    const babelNode = node as {
      type: string;
      loc?: { start: { line: number; column: number } };
      source?: { value: string };
      specifiers?: unknown[];
      importKind?: string;
    };

    if (babelNode.type !== "ImportDeclaration") continue;

    const loc = getLocation(babelNode);
    const path = babelNode.source?.value || "";
    const importKind = (babelNode.importKind as "value" | "type" | "dynamic") || "value";

    if (!babelNode.specifiers?.length) {
      // side-effect import.
      imports.push({
        path,
        names: [],
        line: loc.line,
        column: loc.column,
        importKind: "value",
      });
    } else {
      // collect all names for this path.
      for (const spec of babelNode.specifiers) {
        const specifier = spec as {
          type: string;
          local: { name: string };
          imported: { name: string };
          loc?: { start: { line: number; column: number } };
        };

        let name: string;
        if (specifier.type === "ImportNamespaceSpecifier") {
          // namespace import.
          name = specifier.local?.name || "*";
          imports.push({
            path,
            names: [name],
            line: getLocation(specifier).line,
            column: getLocation(specifier).column,
            importKind,
          });
        } else {
          // named/default import.
          name = specifier.imported?.name || specifier.local?.name || "unknown";
          const existing = pathGroups.get(path);
          if (existing) {
            existing.names.push(name);
          } else {
            pathGroups.set(path, {
              names: [name],
              line: loc.line,
              column: loc.column,
              importKind,
            });
          }
        }
      }
    }
  }
  
  // flush grouped import paths to output.
  for (const [path, data] of pathGroups) {
    imports.push({
      path,
      names: data.names,
      line: data.line,
      column: data.column,
      importKind: data.importKind,
    });
  }

  return imports;
}

// extracts basic function/class signatures.
function extractSignatures(
  body: unknown[],
  content: string
): Signature[] {
  const signatures: Signature[] = [];

  for (const node of body) {
    if (!node || typeof node !== "object") continue;

    const babelNode = node as {
      type: string;
      id?: { name: string };
      loc?: { start: { line: number; column: number } };
      params?: unknown[];
      async?: boolean;
      generator?: boolean;
      body?: unknown;
      returnType?: unknown;
      declarations?: unknown[];
      declaration?: unknown;
    };

    const loc = getLocation(babelNode);

    // top-level function declarations.
    if (babelNode.type === "FunctionDeclaration") {
      signatures.push({
        name: babelNode.id?.name || "anonymous",
        signature: `function ${babelNode.id?.name || "anonymous"}(${(babelNode.params || []).map((p: unknown) => getParamName(p)).join(", ")})`,
        line: loc.line,
        column: loc.column,
        async: babelNode.async || false,
        generator: babelNode.generator || false,
        params: (babelNode.params || []).map((p: unknown) => getParamName(p)),
        jsdoc: extractJsDoc(content, loc.line),
      } as Signature);
      continue;
    }

    if (babelNode.type === "ClassDeclaration") {
      signatures.push({
        name: babelNode.id?.name || "AnonymousClass",
        signature: `class ${babelNode.id?.name || "AnonymousClass"}`,
        line: loc.line,
        column: loc.column,
        async: false,
        generator: false,
        params: [],
      });
      continue;
    }

    // unwrap exported declarations and inspect inside.
    if (babelNode.type === "ExportNamedDeclaration" && babelNode.declaration) {
      const decl = babelNode.declaration as {
        type: string;
        id?: { name: string };
        params?: unknown[];
        async?: boolean;
        generator?: boolean;
        declarations?: unknown[];
        loc?: { start: { line: number; column: number } };
      };

      if (decl.type === "FunctionDeclaration") {
        signatures.push({
          name: decl.id?.name || "anonymous",
          signature: `function ${decl.id?.name || "anonymous"}(${(decl.params || []).map((p: unknown) => getParamName(p)).join(", ")})`,
          line: loc.line,
          column: loc.column,
          async: decl.async || false,
          generator: decl.generator || false,
          params: (decl.params || []).map((p: unknown) => getParamName(p)),
          jsdoc: extractJsDoc(content, loc.line),
        } as Signature);
        continue;
      }

      if (decl.type === "ClassDeclaration") {
        signatures.push({
          name: decl.id?.name || "AnonymousClass",
          signature: `class ${decl.id?.name || "AnonymousClass"}`,
          line: loc.line,
          column: loc.column,
          async: false,
          generator: false,
          params: [],
        });
        continue;
      }

      // picks arrow functions from exported variables.
      if (decl.type === "VariableDeclaration" && decl.declarations?.length) {
        const firstDecl = decl.declarations[0] as {
          id?: { name: string };
          init?: { type: string; params?: unknown[]; async?: boolean; generator?: boolean };
          loc?: { start: { line: number; column: number } };
        };
        if (firstDecl.init?.type === "ArrowFunctionExpression") {
          signatures.push({
            name: firstDecl.id?.name || "anonymous",
            signature: `const ${firstDecl.id?.name || "anonymous"}(${(firstDecl.init.params || []).map((p: unknown) => getParamName(p)).join(", ")}) => ...`,
            line: loc.line,
            column: loc.column,
            async: firstDecl.init.async || false,
            generator: firstDecl.init.generator || false,
            params: (firstDecl.init.params || []).map((p: unknown) => getParamName(p)),
            jsdoc: extractJsDoc(content, loc.line),
          } as Signature);
          continue;
        }
      }
    }

    // standalone function expressions.
    if (babelNode.type === "FunctionExpression" || babelNode.type === "ArrowFunctionExpression") {
      signatures.push({
        name: babelNode.id?.name || "anonymous",
        signature: `${babelNode.type === "ArrowFunctionExpression" ? "arrow" : "function"} expression`,
        line: loc.line,
        column: loc.column,
        async: babelNode.async || false,
        generator: babelNode.generator || false,
        params: (babelNode.params || []).map((p: unknown) => getParamName(p)),
      } as Signature);
    }
  }

  return signatures;
}

// best-effort param name extraction from babel param node.
function getParamName(p: unknown): string {
  const param = p as { name?: string; left?: { name: string }; right?: { name: string }; argument?: { name: string } };
  if (param.name) return param.name;
  if (param.left?.name) return param.left.name;
  if (param.right?.name) return param.right.name;
  if (param.argument?.name) return param.argument.name;
  return "param";
}

// parser plugin contract implementation.
export const jsTsParser: ParserPlugin = {
  extensions: SUPPORTED_EXTENSIONS,
  language: "JavaScript/TypeScript",

  parse(content: string, filePath: string, timeoutMs = 500): ParseResult {
    const startTime = Date.now();

    try {
      const ast = parse(content, BABEL_OPTIONS);
      const parseTimeMs = Date.now() - startTime;

      if (parseTimeMs > timeoutMs) {
        return {
          success: false,
          error: `Parse exceeded timeout: ${parseTimeMs}ms > ${timeoutMs}ms`,
          parseTimeMs,
        };
      }

      return {
        success: true,
        ast,
        parseTimeMs,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown parse error",
        parseTimeMs: Date.now() - startTime,
      };
    }
  },

  extract(ast: BabelAst, filePath: string, content?: string): ExtractionResult {
    // babel wraps module statements under program.body.
    const body = (ast as { program?: { body: unknown[] } }).program?.body || [];

    return {
      exports: extractExports(body, content || ""),
      imports: extractImports(body),
      signatures: extractSignatures(body, content || ""),
    };
  },
};

// helper for callers that always pass source content.
export function extractWithContent(
  ast: Parameters<typeof jsTsParser.extract>[0],
  content: string,
  _filePath: string
): ExtractionResult {
  const body = (ast as { program?: { body: unknown[] } }).program?.body || [];

  return {
    exports: extractExports(body, content),
    imports: extractImports(body),
    signatures: extractSignatures(body, content),
  };
}
