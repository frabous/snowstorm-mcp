# Snowstorm MCP

Local MCP server and Windows editor for authoring Minecraft Blockbuster 1.12.2 particles. It combines a Blockbuster-safe JSON editor, a local Snowstorm preview, GIF/MP4 export, and a reference-video workflow for recreating VFX.

Snowstorm is used for simulation only. The server preserves `blockbuster:*` extensions when files are edited, and never treats a Snowstorm preview as proof of Minecraft rendering.

## Features

- Create, inspect, patch and validate `.particle.json` files.
- Preserve Blockbuster fields when the Snowstorm editor saves a file.
- Render Snowstorm previews as PNG, GIF or MP4.
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
git clone --recurse-submodules https://github.com/YOUR_ACCOUNT/snowstorm-mcp.git
Set-Location snowstorm-mcp
npm install
npx install-electron
npx playwright install chromium
Copy-Item snowstorm-mcp.config.example.json snowstorm-mcp.config.json
npm run build
npm test
```

Edit `snowstorm-mcp.config.json` so its paths target your package. The provided local configuration is intentionally ignored by Git; it may point to a private Minecraft instance.

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

1. Call `particle_design_brief` with `impact`, `aura`, `trail`, `shockwave` or `smoke`.
2. Call `particle_create` or inspect a close reference with `particle_inspect`.
3. Use `particle_patch` with the `expectedDigest` returned by inspection.
4. Run `particle_validate`, then `particle_render`.
5. Run `particle_verify_package` before merging selectors. Test spell helpers with the target package separately.
6. Test the final effect in Minecraft. Snowstorm GIFs do not prove Blockbuster behavior.

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

The server places generated video artifacts under `.snowstorm-mcp/artifacts/video/`, leaving source videos and existing reference images untouched. Scene detection selects visual discontinuities; it does not identify VFX semantics, layers, camera effects or audio beats by itself.

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
| `particle_list` / `particle_inspect` | Compact inventory and optional source JSON. |
| `particle_create` / `particle_patch` | Safe authoring operations. |
| `particle_validate` / `particle_verify_package` | Particle and package checks. |
| `particle_render` | Snowstorm PNG, GIF or MP4 preview. |
| `particle_open_desktop` | Electron editor. |
| `particle_authoring_guide` / `particle_design_brief` | Embedded Snowstorm authoring knowledge. |
| `video_import` | Copy a user-provided video into the automatic managed directory. |
| `video_list` | Discover imported reference videos. |
| `video_analyze` | Scene-aware frames, contact sheet and manifest. |
| `video_extract_frames` | Targeted timecode extraction with decoded PTS reporting. |

## Security and Limits

The server confines configured particle, texture and reference-video paths, rejects traversal, serializes MCP writes, and creates backups. Do not run it against folders writable by untrusted local processes.

Generated previews validate the local Snowstorm simulator only. Verify texture blending, anchors, collisions, selector links, MagicSpells timing and performance inside Minecraft before shipping.

## License

This project is GPL-3.0-or-later because it vendors Snowstorm, which is GPL-3.0-or-later. Snowstorm source is retained in `vendor/snowstorm`; see `NOTICE`.
