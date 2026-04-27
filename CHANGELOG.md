# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0]

### Added
- Initial release of ai-memory CLI
- Deterministic zero-token code memory generator
- Structural scanning with AST extraction for TypeScript/JavaScript
- Git integration for commit grouping and change tracking
- Dual output formats: Markdown and JSON
- Security-hardened file system operations (TOCTOU protection, path traversal prevention)
- Atomic file writes for state and cache integrity
- Configurable exclusion patterns via `.aimemory.json`
- Session notes support for CLAUDE.md and AGENTS.md files

### Security
- Fixed git command argument injection via file paths
- Fixed shell injection in rendered commit commands
- Replaced synchronous FS calls with async to prevent event loop blocking
- Fixed TOCTOU race conditions in symlink resolution
- Implemented atomic state file writes with UUID-based temp files
- Fixed case-sensitive path collision vulnerability
- Excluded sourcemaps from npm package to reduce size and prevent source disclosure

### Performance
- Async file operations throughout the scan pipeline
- UUID-based temp file naming to prevent collision under concurrent runs
- CPU count caching to avoid repeated allocation

