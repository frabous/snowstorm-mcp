# Changelog

Notable changes to Snowstorm MCP are documented here.

## [0.2.0] - 2026-09-29

### Added

- Added gameplay-only MagicSpells helper classification, `gameplayHelpers` counts, non-blocking `TargetedMultiSpell` delay diagnostics, and a `scheduling-skipped` guard.
- Added explicit UTF-8 BOM validation and actionable `spawn_rate` scene-rendering diagnostics.
- Added `selectors_merge` with dry-run reports, collision handling, optimistic digest checks, backups and guarded writes.
- Added shared texture banks, decoded coverage metrics, metadata caching, and the `texture_generate`, `texture_list`, `texture_import` and `flipbook_atlas` tools.
- Added nine texture primitives, including mip-safe `soft_lens` and the measured 35% bright-coverage guard.
- Added multi-project registries, `project_list` and `project_use`, while preserving legacy flat configuration files.
- Added MCP registration, project-switch concurrency, file-publication and Snowstorm automation-hook regression tests.

### Changed

- Expanded the authoring guide with texture recipes, numeric/Molang conventions, tint guidance and Minecraft verification notes.
- Consolidated file locks, artifact paths, project-root resolution and standard process/FFmpeg helpers.
- Updated README setup instructions for Claude Code, Codex CLI and OpenCode, including a reusable AI setup prompt.

### Fixed

- Prevented numeric or BOM-related input failures from being obscured by misleading validation cascades.
- Prevented project switches from redirecting in-flight tool requests to another project's files.
- Made new texture asset publication atomic and non-overwriting; configuration guards run immediately before publication.
- Rejected malformed or unknown `activeProject` values and made the default project deterministic.
