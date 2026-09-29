# Snowstorm MCP

Local MCP server and Windows editor for authoring Minecraft Blockbuster 1.12.2 particles. It combines a Blockbuster-safe JSON editor, a local Snowstorm preview, GIF/MP4 export, and a reference-video workflow for recreating VFX.

Snowstorm is used for simulation only. The server preserves `blockbuster:*` extensions when files are edited, and never treats a Snowstorm preview as proof of Minecraft rendering.

## Features

- Create, inspect, patch and validate `.particle.json` files.
- Query selected fields across many particles and patch a preflighted batch with coordinated rollback.
- Preserve Blockbuster fields when the Snowstorm editor saves a file.
- Validate particle, texture, selector and MagicSpells links as one package graph.
- Classify gameplay-only MagicSpells helpers without requiring fake particle selectors; report `TargetedMultiSpell` delays as non-blocking warnings.
- Merge selector fragments into an instance file with conflict reporting, dry-run artifacts, digest checks and backups.
- Inspect or retime a MagicSpells `.MultiSpell` without rewriting unrelated definitions.
- Render deterministic single-particle or absolute-timeline scene previews as PNG, GIF or MP4.
- Compose a scene with per-layer camera cuts, a solo layer, in-memory layer overrides and activity-derived sample times.
- Probe Molang values at explicit ages with per-field, absolute-bound and cross-field assertions.
- Inspect real particle PNGs side by side on a checkerboard with their declared dimensions.
- Generate nine measured texture primitives, import PNGs into configured shared banks, browse a texture catalogue and calculate flipbook UVs from real images.
- Switch among configured projects at runtime with `project_list` and `project_use`; existing flat single-project configs remain supported.
- Open a selected particle in a secure local Electron window.
- Expose the built-in Blockbuster/Snowstorm authoring guide and effect design briefs to MCP clients.
- Import source videos into an automatically managed folder, then analyze them with FFmpeg scene detection.
- Generate JPEG contact sheets, a JSON manifest and individual frames named with millisecond timecodes.
- Extract decoded frames at requested `HH:MM:SS.mmm` targets and report their decoded PTS for vision-capable AI review.

## Requirements

- Windows 10 or later.
- Node.js 22.12 or newer.
- FFmpeg and FFprobe available on `PATH`.
- Git, for cloning Snowstorm as a submodule.

## Installation

```powershell
git clone --recurse-submodules https://github.com/frabous/snowstorm-mcp.git
Set-Location snowstorm-mcp
npm install
npx install-electron
npx playwright install chromium
Copy-Item snowstorm-mcp.config.example.json snowstorm-mcp.config.json
npm run build
npm test
```

Edit `snowstorm-mcp.config.json` so its paths target your package. The provided local configuration is intentionally ignored by Git; it may point to a private Minecraft instance.

The legacy flat configuration describes one project and continues to work. To switch projects without restarting, use the registry format below. Adding or changing project definitions on disk requires a restart; selecting one of the already configured projects does not.

Example layout:

```text
my-package/
  particles/
  resourcepack/
  selectors.json
  spell.yml
```

## MCP Client Configuration

The npm package provides a `snowstorm-mcp` executable for local stdio. After version `0.3.0` is published, clients can launch it with `npx --yes snowstorm-mcp@0.3.0`; set `SNOWSTORM_MCP_CONFIG` to the absolute path of the selected project configuration. For a source checkout, use `node <repository>/dist/mcp.js` instead.

### Claude Code

Use user scope to make the server available across Claude Code projects, or choose a narrower scope if preferred:

```powershell
claude mcp add --scope user --transport stdio --env "SNOWSTORM_MCP_CONFIG=C:\path\to\my-project\snowstorm-mcp.config.json" snowstorm-mcp -- npx --yes snowstorm-mcp@0.3.0
claude mcp list
```

In a Claude Code session, run `/mcp` to inspect the connection and tools.

### Codex CLI

Codex CLI, the Codex IDE extension and the ChatGPT desktop app share the Codex MCP configuration:

```powershell
codex mcp add snowstorm-mcp --env "SNOWSTORM_MCP_CONFIG=C:\path\to\my-project\snowstorm-mcp.config.json" -- npx --yes snowstorm-mcp@0.3.0
codex mcp list
```

### OpenCode

Add this entry to OpenCode's `mcp` configuration. The same shape works in a project `opencode.json` or the user's global OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "snowstorm-mcp": {
      "type": "local",
      "command": ["npx", "--yes", "snowstorm-mcp@0.3.0"],
      "environment": {
        "SNOWSTORM_MCP_CONFIG": "C:\\path\\to\\my-project\\snowstorm-mcp.config.json"
      },
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

Use `opencode mcp list` to verify the server. Restart the client after changing its configuration.

### Copy-paste setup prompt for an AI agent

Give the following prompt to Claude Code, Codex CLI, OpenCode or another computer-use/coding agent to set up Snowstorm MCP on your machine:

```text
Set up this Snowstorm MCP installation on my machine.

Source checkout (if needed for a local fallback): <absolute path to snowstorm-mcp>
Particle project(s): <absolute path(s) to my package(s), or ask me to identify them>
Clients to configure: detect Claude Code, Codex CLI, OpenCode and other installed MCP clients; configure each one I approve.

Work through these steps and report what you did:
1. Inspect the operating system, shell, repository, existing MCP configuration files, and installed client versions. Use each client's current official documentation for its exact config location, command syntax, scope and verification command. Do not assume that another client's JSON format applies. This project documents Windows support; if the OS is different, explain the MCP-only limitations before proceeding.
2. Check Node.js, npm, FFmpeg and FFprobe availability. Check whether dependencies are installed, Chromium is available for Playwright, and `dist/mcp.js` exists. Show any prerequisite installs or PATH changes and get my approval before performing them.
3. Inspect `snowstorm-mcp.config.schema.json` and the package layout. Ask me for any missing or ambiguous particle, resource-pack, selector, instance-selector, spell or artifact paths. Never invent project paths. Keep secrets out of files, logs and chat.
4. Create or update `snowstorm-mcp.config.json` only after showing me the proposed values. Use the legacy flat format for one project or the registry format for several projects. Keep every path valid. Use `../library/textures` as the default shared texture bank when that matches this repository layout; preserve an explicit `sharedTextureBanks` list or `[]` if I have one. Set `instanceSelectorsFile` only to the real instance selectors file.
5. Run `npm install` only if dependencies are absent and I approve it, then run `npm run build` and `npm test`. Do not run any tool that writes particles, selectors, textures or other game assets during setup.
6. Check whether `snowstorm-mcp@0.3.0` is available on npm. If so, configure the local stdio command as `npx --yes snowstorm-mcp@0.3.0`; otherwise use `node <absolute-repository-path>/dist/mcp.js` from the existing checkout and tell me the npm release is not published yet. Set `SNOWSTORM_MCP_CONFIG` to the absolute config path. For each approved client, merge one server entry without removing or rewriting unrelated settings. Choose user/global or project/local scope only after checking the client's behavior and confirming my preference. Back up an existing client config before editing it.
7. Start a fresh client session and use that client's documented MCP status/list command. Verify the server exposes its tools, call `project_list`, then run `particle_list` only if the selected project path is valid. Do not call a mutating tool as a connection test.
8. Summarize configured clients and scopes, files changed, exact verification results, and any remaining issue. Leave private per-machine config files uncommitted.
```

The npx-installed server includes Snowstorm for rendering. `particle_open_desktop` additionally requires Electron installed in the project checkout; use the source installation above for the Electron editor.

## Project Registry and Shared Texture Banks

The flat configuration remains supported for one project. For several projects, use a registry with the project identifier as each key. `sharedTextureBanks` belongs at registry level and applies to every configured project:

```json
{
  "$schema": "./snowstorm-mcp.config.schema.json",
  "activeProject": "spell-a",
  "sharedTextureBanks": ["../library/textures"],
  "projects": {
    "spell-a": {
      "projectName": "spell-a",
      "particlesRoot": "../spell-a/particles",
      "resourcePackRoot": "../spell-a/resourcepack",
      "selectorsFile": "../spell-a/selectors.json",
      "instanceSelectorsFile": "../spell-a/config/metamorph/selectors.json",
      "spellFile": "../spell-a/spell.yml",
      "artifactsRoot": "./.snowstorm-mcp/artifacts/spell-a"
    },
    "spell-b": {
      "projectName": "spell-b",
      "particlesRoot": "../spell-b/particles",
      "resourcePackRoot": "../spell-b/resourcepack",
      "selectorsFile": "../spell-b/selectors.json",
      "spellFile": "../spell-b/spell.yml",
      "artifactsRoot": "./.snowstorm-mcp/artifacts/spell-b"
    }
  }
}
```

Use `project_list` to see configured keys and the active project, then `project_use` to switch immediately. Add `instanceSelectorsFile` when `selectors_merge` should default to the real instance selectors file; a live merge requires `write: true`, `dryRun: false` and the inspected SHA-256 digest. If `sharedTextureBanks` is omitted, the server resolves the recommended `../library/textures` path relative to the configuration file. Set it to `[]` to disable shared banks.

`texture_generate` writes to the project resource pack unless a configured bank is selected. `texture_import` copies a PNG into a configured bank. `texture_list` shows the winning source and particles using each texture; project textures take precedence over shared-bank duplicates.

## Particle Workflow

1. Call `particle_design_brief`, or request one focused topic from `particle_authoring_guide`.
2. Use `particle_query` to compare only the required fields across references. It collapses common values.
3. Call `particle_create`, `particle_patch`, or dry-run `particle_patch_batch` before executing the batch.
4. Run `particle_verify_package`. Use `detail: "full"` only when the timeline rows are needed.
5. Use `particle_probe` for motion or scale claims, then `particle_render_scene` for the relevant absolute-time window.
6. Test the final effect in Minecraft. Snowstorm evidence does not prove Blockbuster behavior.

For timing-only changes, inspect with `spell_timeline_inspect`, then call `spell_retime` with its digest. Starts can be supplied in ticks or seconds and must align to the configured tick grid.

Example projected query:

```json
{
  "nameContains": "shockwave",
  "select": {
    "count": "/particle_effect/components/minecraft:emitter_rate_instant/num_particles",
    "lifetime": "/particle_effect/components/minecraft:particle_lifetime_expression/max_lifetime"
  },
  "collapseCommon": true
}
```

`particle_render_scene` accepts explicit `{file, startSeconds, position}` layers or derives layers, absolute starts and static helper offsets from the configured MagicSpells graph. Camera coordinates accept finite numbers or numeric strings. Render windows are capped at 30 seconds, 750 frames and a 480-million rendered-pixel budget. The result includes compact lifecycle checks, a contact sheet, a report and an optional GIF/MP4.

Snowstorm builds its particle material with depth writing enabled, and every quad of an emitter shares one unsorted buffer, so overlapping quads stencil each other with hard straight edges that do not occur in Minecraft. `depthWrite: false` is therefore the default, and `grid: false` hides the ground grid and origin axes, which exist only in the preview. Both settings are reported back in `caveats`. A straight contour that survives with `depthWrite: false` is the particle texture's own alpha, not a compositing artefact.

`particle_patch` refuses to replace a numeric field with a bare numeric string such as `"9"`. Such a value is a valid Molang literal, so it cannot be caught by semantic validation, and MCP clients sometimes send numbers as strings. Fields that already hold a quoted number are still rendered correctly.

`shots` cuts the camera across the window, so a sequence that needs one framing near the caster and another at 26 blocks no longer has to compromise on a single camera. `solo` renders one layer alone, which is how a composited artefact is attributed. A layer's `overrides` are applied in memory and are never written, so a throwaway diagnostic variant cannot end up in the delivery folder; the result names every overridden layer and says so in `caveats`. Omit `sampleTimes` and they are derived from each layer's own start, midpoint and tail, and `sampleTimesSource` reports which happened.

## Texture Inspection

`texture_contact_sheet` renders up to 16 real PNGs on a checkerboard with their dimensions, bytes and alpha flag. It is the only view that separates an artwork defect from a compositing artefact: a hard straight contour on a tile is the texture's own alpha, and it survives a scene render with `depthWrite` disabled.

`texture_generate` writes a named PNG into the project resource pack or a selected shared bank. It supports `soft_lens`, `anime_cloud`, `faceted_crystal`, `bokeh_disc`, `puff`, `ember`, `streak`, `lightning` and `beam_core`. The `soft_lens` primitive measures decoded pixels and refuses a bright-frame coverage below 35%. `texture_list` catalogs project and bank assets by name, dimensions, alpha, coverage and usage. `texture_import` validates and copies an external PNG into a configured bank without overwriting existing files. `flipbook_atlas` calculates its UV values from the actual dimensions of a resolved PNG.

Texture metrics and Snowstorm previews help inspect assets; they do not prove Minecraft playback. Pre-colored textures generally need a neutral tint, and generated PNGs still need to be checked in the target game.

```json
{
  "textures": [
    "b.a:particles/serious_punch/cloud_sheet",
    "b.a:particles/serious_punch/tunnel_ring"
  ]
}
```

## Probing Claims

`particle_probe` maps an alias to a JSON Pointer, and assertions reference the alias. A JSON pointer in `field` is rejected by name.

```json
{
  "file": "serious_punch_tunnel_rings.particle.json",
  "select": {
    "size": "/particle_effect/components/minecraft:particle_appearance_billboard/size",
    "alpha": "/particle_effect/components/minecraft:particle_appearance_tinting/color/3"
  },
  "samples": [{ "age": 0.2 }, { "age": 0.9 }, { "age": 1.6 }],
  "assertions": [
    { "field": "size", "sampleIndexes": [0, 1, 2], "metric": "length", "direction": "increasing" },
    { "field": "size", "sampleIndexes": [0, 2], "metric": "length", "maxValue": 20 },
    { "combine": { "op": "multiply", "fields": ["size", "alpha"] }, "sampleIndexes": [0, 1, 2], "metric": "value", "maxValue": 4 }
  ]
}
```

`minValue` and `maxValue` are absolute bounds, which is what a "must not swallow the camera" or "must not white out" invariant actually needs; `minRatio` and `maxRatio` remain relative to the first sample. `combine` reduces several fields into one series, so a cross-field invariant such as particle count times alpha needs no local checker.

`particle_authoring_guide` embeds the Snowstorm/Blockbuster skill directly in the MCP. Request one of `workflow`, `components`, `blockbuster`, `motion`, `textures`, `magicspells`, `validation` or `reference-video` to minimize context; omit `topic` only when the AI needs the complete guide.

## Video Reference Workflow

`referenceVideosRoot` is optional. When omitted, the MCP creates and manages:

```text
.snowstorm-mcp/artifacts/reference-videos/
```

Give the AI the path to a source video. It calls `video_import`, which copies it into the managed directory without changing the original file. Then use the returned `file` value with `video_analyze`:

```json
{
  "sourcePath": "D:\\references\\my-vfx-reference.mp4"
}
```

The result includes `file`, for example `my-vfx-reference.mp4`. Call:

```json
{
  "file": "my-vfx-reference.mp4",
  "samples": 12
}
```

`video_analyze` returns:

- An inline JPEG contact sheet for an MCP client with vision support.
- `contact-sheet.jpg` on disk.
- `manifest.json` containing duration, resolution, detected scene times and every extracted frame path.
- Frame names such as `frame-03-00-00-12.500.jpg`.

For a closer VFX transition, call `video_extract_frames`. It reports both the requested target and the actual decoded frame PTS, since frames only exist at real stream timestamps:

```json
{
  "file": "megumin-reference.mp4",
  "timecodes": ["00:00:12.500", "00:00:12.750", "00:00:13.000"]
}
```

For audio-led timing, use `video_audio_transients`. It ranks high-pass attacks in a bounded mixed-audio window; these are candidate timings, not isolated SFX recognition. Use `video_compare` after a scene render to make a reference-left/Snowstorm-right MP4 with the reference audio retained. It only reads preview MP4s inside the MCP artifact root and writes its output under `.snowstorm-mcp/artifacts/comparisons/`.

```json
{
  "file": "megumin-reference.mp4",
  "previewPath": "C:\\project\\.snowstorm-mcp\\artifacts\\scenes\\run\\scene.mp4",
  "referenceStartSeconds": 32,
  "durationSeconds": 4.5
}
```

The server places generated video artifacts under `.snowstorm-mcp/artifacts/video/`, leaving source videos and existing reference images untouched. Scene detection selects visual discontinuities; it does not identify VFX semantics, layers or camera effects by itself.

## Desktop Editor

```powershell
npm run desktop
```

Open a particular particle with:

```powershell
npx electron . "C:\full\path\to\effect.particle.json"
```

The `Save safely` control merges Snowstorm's output with the prior Blockbuster document and creates a backup under `.snowstorm-mcp/artifacts/backups`.

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `particle_list` / `particle_inspect` / `particle_query` | Compact inventory, source inspection and projected multi-file reads. |
| `particle_create` / `particle_patch` / `particle_patch_batch` | Safe single-file writes or preflighted batches with best-effort rollback. |
| `particle_validate` / `particle_verify_package` | Semantic particle and complete package-graph checks. |
| `spell_timeline_inspect` / `spell_retime` | Strict MagicSpells timeline reading and timing-only edits. |
| `particle_probe` | Numeric Molang samples with per-field, absolute-bound and cross-field assertions. |
| `particle_render` / `particle_render_scene` | Single-particle or deterministic multi-layer previews, with camera cuts, solo layers and in-memory overrides. |
| `selectors_merge` | Dry-run or digest-checked additive merge of a package selectors fragment into the configured instance file. |
| `texture_generate` / `texture_import` | Generate measured texture primitives or copy an external PNG into a shared bank. |
| `texture_list` / `flipbook_atlas` / `texture_contact_sheet` | Browse assets and their usage, compute UV values, or inspect PNGs on a checkerboard. |
| `project_list` / `project_use` | Inspect configured projects and switch the active one without restarting. |
| `particle_open_desktop` | Electron editor. |
| `particle_authoring_guide` / `particle_design_brief` | Embedded Snowstorm authoring knowledge. |
| `video_import` | Copy a user-provided video into the automatic managed directory. |
| `video_list` | Discover imported reference videos. |
| `video_analyze` | Scene-aware frames, contact sheet and manifest. |
| `video_audio_transients` | Mixed-track high-pass attack candidates for timing. |
| `video_extract_frames` | Targeted timecode extraction with decoded PTS reporting. |
| `video_compare` | Side-by-side reference/preview MP4 with reference audio. |

## Security and Limits

The server confines configured particle, texture and reference-video paths, rejects traversal including symlink escapes, serializes MCP writes, and creates backups. Batch writes lock every target, verify every digest before mutation and attempt every rollback if a rename fails. New texture assets publish atomically without replacing an existing file. If a process crashes while holding a file lock, the next write reports the lock path; remove it only after confirming no Snowstorm MCP writer is still running. A process crash can still interrupt a multi-file commit, so retained backups remain the recovery source. Do not run it against folders writable by untrusted local processes.

Generated previews validate the local Snowstorm simulator only. Verify texture blending, anchors, collisions, selector links, MagicSpells timing and performance inside Minecraft before shipping.

## License

This project is GPL-3.0-or-later because it vendors Snowstorm, which is GPL-3.0-or-later. Snowstorm source is retained in `vendor/snowstorm`; see `NOTICE`.
