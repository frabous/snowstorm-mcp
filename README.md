# Snowstorm MCP

Local MCP server and Windows editor for authoring Minecraft Blockbuster 1.12.2 particles. It combines a Blockbuster-safe JSON editor, a local Snowstorm preview, GIF/MP4 export, and a reference-video workflow for recreating VFX.

Snowstorm is used for simulation only. The server preserves `blockbuster:*` extensions when files are edited, and never treats a Snowstorm preview as proof of Minecraft rendering.

## Features

- Create, inspect, patch and validate `.particle.json` files.
- Query selected fields across many particles and patch a preflighted batch with coordinated rollback.
- Preserve Blockbuster fields when the Snowstorm editor saves a file.
- Validate particle, texture, selector and MagicSpells links as one package graph.
- Inspect or retime a MagicSpells `.MultiSpell` without rewriting unrelated definitions.
- Render deterministic single-particle or absolute-timeline scene previews as PNG, GIF or MP4.
- Compose a scene with per-layer camera cuts, a solo layer, in-memory layer overrides and activity-derived sample times.
- Probe Molang values at explicit ages with per-field, absolute-bound and cross-field assertions.
- Inspect real particle PNGs side by side on a checkerboard with their declared dimensions.
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

Configuration is read once at startup. Repointing the file at another package does not rebind a running server, so every particle path reports the project it is still bound to and asks for a restart instead of failing with a bare `ENOENT`.

Example layout:

```text
my-package/
  particles/
  resourcepack/
  selectors.json
  spell.yml
```

## OpenCode Configuration

Add this server entry to OpenCode's `mcp` configuration after building. Use absolute paths on Windows.

```json
{
  "snowstorm-mcp": {
    "type": "local",
    "command": ["node", "C:\\path\\to\\snowstorm-mcp\\dist\\mcp.js"],
    "environment": {
      "SNOWSTORM_MCP_CONFIG": "C:\\path\\to\\snowstorm-mcp\\snowstorm-mcp.config.json"
    },
    "enabled": true,
    "timeout": 120000
  }
}
```

Restart OpenCode after changing its configuration.

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
| `texture_contact_sheet` | Real PNGs on a checkerboard with declared dimensions. |
| `particle_open_desktop` | Electron editor. |
| `particle_authoring_guide` / `particle_design_brief` | Embedded Snowstorm authoring knowledge. |
| `video_import` | Copy a user-provided video into the automatic managed directory. |
| `video_list` | Discover imported reference videos. |
| `video_analyze` | Scene-aware frames, contact sheet and manifest. |
| `video_audio_transients` | Mixed-track high-pass attack candidates for timing. |
| `video_extract_frames` | Targeted timecode extraction with decoded PTS reporting. |
| `video_compare` | Side-by-side reference/preview MP4 with reference audio. |

## Security and Limits

The server confines configured particle, texture and reference-video paths, rejects traversal including symlink escapes, serializes MCP writes, and creates backups. Batch writes lock every target, verify every digest before mutation and attempt every rollback if a rename fails. A process crash can still interrupt a multi-file commit, so retained backups remain the recovery source. Do not run it against folders writable by untrusted local processes.

Generated previews validate the local Snowstorm simulator only. Verify texture blending, anchors, collisions, selector links, MagicSpells timing and performance inside Minecraft before shipping.

## License

This project is GPL-3.0-or-later because it vendors Snowstorm, which is GPL-3.0-or-later. Snowstorm source is retained in `vendor/snowstorm`; see `NOTICE`.
