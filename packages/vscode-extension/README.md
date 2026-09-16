# Memo-log for VS Code

Read-only deterministic AI memory viewer. Zero network calls, zero eval, zero hallucination.

## Install

Search `kaungzawthant.memo-log-vscode` in the Extensions tab, or install from [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kaungzawthant.memo-log-vscode) / [Open VSX](https://open-vsx.org/extension/kaungzawthant/memo-log-vscode).

## Setup

1. Install the memo-log CLI: `npm install -g memo-log`
2. Enable the extension: set `memo-log.enabled` to `true` in your workspace settings
3. Run `memo-log: Scan Now` from the command palette

## Features

- **Sidebar tree** showing memory entries at a glance
- **Code lenses** on exports linking to relevant memory entries
- **Status bar** showing last scan time and file count
- **Read-only webview** for the full AI memory file
- **scanOnSave** option to auto-rescan when you save files
- Reads custom output paths from `.memolog.json` config

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `memo-log.enabled` | `false` | Must be explicitly enabled |
| `memo-log.scanOnSave` | `false` | Auto-scan on file save |

## Security

- Untrusted workspaces: extension stays completely inert
- Only `scan` and `audit` CLI commands are allowed
- No shell interpolation — args passed as arrays via `execa`
- No network calls from the extension itself

## Requirements

- Node.js >= 18
- `memo-log` CLI (`npm i -g memo-log`) or it falls back to `npx memo-log`
- VS Code >= 1.85.0

## Validate your config

Run `memo-log validate` in your terminal to check `.memolog.json` is valid.
