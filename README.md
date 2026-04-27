# memo-log

A **zero-token, static-analysis CLI** that acts as a **post-execution alignment layer** for AI-written code. It scans what actually exists on disk, generates deterministic dual-audience memory (`AI_MEMORY.md` + `AI_MEMORY.json`), and anchors every claim to source references.

## Why?

AI coding tools generate code fast, but most people don't verify what was written. `memo-log` reads your codebase deterministically — no LLM calls, no tokens, no guessing — and produces a structured memory file that both developers and non-technical stakeholders can understand.

## Install

```bash
npm install -g memo-log
```

Or use without installing:

```bash
npx memo-log scan ./my-project
```

## CLI

### `init`

Create default config in a project directory:

```bash
memo-log init ./my-project
```

Creates `.aimemory.json` with default settings:

```json
{
  "languages": ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
  "exclude": [".git", "node_modules", "dist", "build", ".ai-memory"],
  "output": { "markdown": "AI_MEMORY.md", "json": "AI_MEMORY.json" },
  "maxDepth": 20,
  "mode": "dual"
}
```

### `scan`

Scan a project and generate memory files:

```bash
memo-log scan ./my-project [options]
```

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `--mode` | `tech`, `simple`, `dual`, `brief` | `dual` | Output audience mode |
| `--format` | `md`, `json`, `both` | `both` | Output format |
| `--out <path>` | file path | — | Override output path (single format only) |
| `--config <path>` | file path | — | Config file override |
| `--max-depth <n>` | integer | 20 | Maximum directory traversal depth |
| `--timeout-ms <n>` | integer | 30000 | Scan timeout in milliseconds |
| `--max-file-size-bytes <n>` | integer | 2097152 | Skip files larger than this |
| `--quiet` | — | — | Suppress warning output |
| `--include-agent-notes` | — | — | Append agent session notes (marked unverified) |

**Mode descriptions:**

- **`tech`** — Engineering Ledger only (function signatures, export references)
- **`simple`** — Executive Brief only (plain-English descriptions)
- **`dual`** — Both sections (default)
- **`brief`** — Condensed stakeholder summary

### `commits`

Generate conventional commit suggestions grouped by semantic scope:

```bash
memo-log commits ./my-project [options]
```

| Option | Description |
|--------|-------------|
| `--dry-run` | Print commit commands without executing (default behavior) |
| `--apply` | Execute `git commit` for each group |

Commit scope mapping:

| Path pattern | Scope | Type |
|-------------|-------|------|
| `src/auth/**` | `auth` | `feat` / `fix` |
| `src/api/**` | `api` | `feat` / `fix` |
| `src/components/**` | `components` | `feat` / `fix` |
| `*.css / *.scss` | `styles` | `style` |
| `*.test.*` | `test` | `test` |
| `package.json / *.config.*` | `chore` | `chore` |

## Output

### `AI_MEMORY.md` (Human-readable)

```markdown
# AI Memory Snapshot

_Last generated: 1970-01-01T00:00:00.000Z_

## Impact Summary
- **Files analyzed:** 12
- **Modules documented:** 18
- **Languages detected:** ts, tsx

## Executive Brief (Non-Technical)
### 🔐 Authentication & Security
- User login & security checks: login user [src/auth/login.ts:1:0]

## Engineering Ledger (Technical)
### 🔐 AUTH (1)
- Authentication & session middleware: `loginUser` [src/auth/login.ts:1:0]

## 📅 Recent Changes
### 🔐 Authentication & Security
- 🔄 **Modified:** `src/auth/login.ts` [changed]
```

### `AI_MEMORY.json` (Machine-readable)

Schema-validated (Zod) snapshot with version, entries, warnings, and metadata.

### `.ai-memory/state.json` (Internal state)

SHA-256 hashes + structural fingerprints for diff/realignment on subsequent scans.

## State & Diff Engine

On each `scan`, `memo-log`:

1. Loads previous state from `.ai-memory/state.json`
2. Scans current code and computes hashes + fingerprints
3. Classifies every file as `ADDED`, `MODIFIED`, `REMOVED`, or `UNTOUCHED`
4. Appends `📅 Recent Changes` section to markdown (when previous state exists)
5. Warns about stale references (entries pointing to deleted files)
6. Writes updated state atomically

## Security Model

| Threat | Mitigation |
|--------|-----------|
| Path traversal (`../escape`) | Rejected at walker + pathGuards layer |
| Symlink escape | `realpath` resolution + root containment check |
| File size bomb | >2MB files skipped with warning |
| Regex DoS | Per-line length cap (16KB), content size limit (512KB) |
| TOCTOU race | Pre/post stat size comparison during read |
| Null byte injection | Rejected in path normalization |
| Dynamic code execution | No `eval`, `exec`, `vm`, or dynamic `import()` outside plugin loader |

## Anti-Hallucination Guarantees

1. **Zero external calls** — No HTTP, no LLM, no cloud API. Pure local execution.
2. **Reference requirement** — Every summary bullet includes `[file:line]` or `[file:line:col]`. Unverifiable claims are dropped.
3. **Deterministic templates** — Summaries use rule-based conditionals only. No generative language.
4. **Schema validation** — `AI_MEMORY.json` validated against Zod schema. Invalid → CLI exits with error.
5. **Hash-verified state** — `.ai-memory/state.json` uses SHA-256 + structural fingerprints for diff.
6. **Fail-fast on ambiguity** — If AST parse fails, falls back to regex. Never guesses intent.
7. **Open audit trail** — All logic is deterministic. Run `memo-log scan` twice on same code → identical output.

## IDE Compatibility

All AI coding tools (Cursor, Claude Code, GitHub Copilot, Codex, OpenCode) index workspace `.md`/`.json` files. Drop `AI_MEMORY.md` and `AI_MEMORY.json` in your project root — they auto-read it.

| IDE/Agent | Integration |
|-----------|------------|
| Cursor / Claude Code / OpenCode | Reads `AI_MEMORY.md`/`.json` natively |
| GitHub Copilot / VS Code | Same; optional thin extension for Week 2 |
| Codex | Reads workspace memory files |

No tight coupling. The tool drops structured, version-controlled memory alongside your code.

## Configuration

Create `.aimemory.json` in your project root (or run `memo-log init`):

```json
{
  "languages": ["ts", "tsx", "js", "jsx"],
  "exclude": [".git", "node_modules", "dist", "build", ".ai-memory"],
  "output": {
    "markdown": "AI_MEMORY.md",
    "json": "AI_MEMORY.json"
  },
  "maxDepth": 20,
  "mode": "dual"
}
```

## Requirements

- Node.js >= 18.0.0
- Git (for `commits` command only)

## License

MIT
