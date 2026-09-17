import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { openDesktop } from "./desktop-launcher.js";
import { applyPatch, ParticleStore, summarizeParticle } from "./particle-store.js";
import { renderParticle } from "./renderer.js";
import { createTemplate, templateNames } from "./templates.js";
import type { JsonObject, JsonPatchOperation, JsonValue } from "./types.js";
import { validatePackage, validateParticle } from "./validator.js";
import { authoringGuideFor, authoringTopics, designBrief } from "./authoring-guide.js";
import { VideoAnalyzer } from "./video.js";

function asObject(value: unknown, name: string): JsonObject {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${name} must be a JSON object.`);
  return value as JsonObject;
}

function jsonResult(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], isError };
}

const patchOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["add", "replace", "test"]), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: z.string() })
]);

async function createMcpServer(): Promise<McpServer> {
  const config = await loadConfig();
  const store = new ParticleStore(config);
  const videos = new VideoAnalyzer(config);
  const server = new McpServer(
    { name: "snowstorm-mcp", version: "0.1.0" },
    {
      instructions: "Create and edit Minecraft Blockbuster 1.12 particle JSON safely. Inspect before editing. Do not remove blockbuster:* components unless explicitly requested. Rendered images prove Snowstorm's preview only, never Minecraft playback."
    }
  );

  server.registerTool("particle_list", {
    description: "List particles as compact summaries: identifier, texture, standard components, and Blockbuster extensions.",
    inputSchema: z.object({ nameContains: z.string().optional() })
  }, async ({ nameContains }) => {
    const particles = await store.list();
    const needle = nameContains?.toLowerCase();
    return jsonResult(needle ? particles.filter((particle) => particle.file.toLowerCase().includes(needle) || particle.identifier?.toLowerCase().includes(needle)) : particles);
  });

  server.registerTool("particle_inspect", {
    description: "Inspect one particle. JSON is omitted by default to save context tokens.",
    inputSchema: z.object({ file: z.string(), includeJson: z.boolean().default(false) })
  }, async ({ file, includeJson }) => {
    const source = await store.readRaw(file);
    return jsonResult({ digest: source.digest, summary: summarizeParticle(source.document, file), document: includeJson ? source.document : undefined });
  });

  server.registerTool("particle_create", {
    description: "Create a new particle from a compact starter template or a supplied JSON document. Existing files are never overwritten by this tool.",
    inputSchema: z.object({
      file: z.string(),
      identifier: z.string().min(1),
      texture: z.string().min(1),
      template: z.enum(templateNames).optional(),
      document: z.unknown().optional(),
      dryRun: z.boolean().default(false)
    })
  }, async ({ file, identifier, texture, template, document, dryRun }) => {
    if (await store.exists(file)) throw new Error(`Refusing to overwrite existing particle: ${file}`);
    const created = document ? asObject(document, "document") : createTemplate(template ?? "burst", identifier, texture);
    const validation = await validateParticle(created, config, file);
    if (!validation.valid) return jsonResult({ created: false, validation }, true);
    if (dryRun) return jsonResult({ created: false, dryRun: true, validation });
    const write = await store.create(file, created);
    return jsonResult({ created: true, write, validation });
  });

  server.registerTool("particle_patch", {
    description: "Apply RFC 6902 add, replace, remove, and test operations to one particle. Uses an expected SHA-256 digest to avoid overwriting an externally changed file.",
    inputSchema: z.object({
      file: z.string(),
      operations: z.array(patchOperationSchema).min(1),
      expectedDigest: z.string().length(64),
      dryRun: z.boolean().default(false)
    })
  }, async ({ file, operations, expectedDigest, dryRun }) => {
    const source = await store.readRaw(file);
    const patched = applyPatch(source.document, operations as JsonPatchOperation[]);
    const validation = await validateParticle(patched, config, file);
    if (!validation.valid) return jsonResult({ updated: false, validation }, true);
    if (dryRun) return jsonResult({ updated: false, dryRun: true, digest: source.digest, validation });
    const write = await store.write(file, patched, expectedDigest);
    return jsonResult({ updated: true, write, validation });
  });

  server.registerTool("particle_validate", {
    description: "Validate Bedrock/Snowstorm structure, Blockbuster-compatible components, texture resolution, collision assumptions, and finite lifetime risks.",
    inputSchema: z.object({ file: z.string() })
  }, async ({ file }) => jsonResult(await validateParticle(await store.read(file), config, file)));

  server.registerTool("particle_verify_package", {
    description: "Validate selector JSON and report package inventory without modifying files.",
    inputSchema: z.object({}).default({})
  }, async () => {
    const validation = await validatePackage(config);
    const particles = await store.list();
    return jsonResult({ ...validation, particleCount: particles.length, particleFiles: particles.map((particle) => particle.file) });
  });

  server.registerTool("particle_render", {
    description: "Render one particle through Snowstorm's local WebGL preview. Returns a PNG inline and optionally writes GIF or MP4 artifacts. This is not proof of the Minecraft render.",
    inputSchema: z.object({
      file: z.string(),
      durationSeconds: z.number().positive().max(15).default(1.5),
      fps: z.number().int().min(1).max(30).default(12),
      width: z.number().int().min(320).max(1920).default(960),
      height: z.number().int().min(240).max(1080).default(540),
      format: z.enum(["png", "gif", "mp4"]).default("png")
    })
  }, async (options) => {
    const result = await renderParticle(store, config, options);
    const image = await readFile(result.previewPng);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ ...result, previewCaveat: "Snowstorm preview only; validate in Minecraft before shipping." }, null, 2) },
        { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" }
      ]
    };
  });

  server.registerTool("particle_open_desktop", {
    description: "Builds must already exist. Opens one particle in the local secure Electron Snowstorm editor; its Save safely control preserves Blockbuster extensions.",
    inputSchema: z.object({ file: z.string() })
  }, async ({ file }) => jsonResult(await openDesktop(store, config, file)));

  server.registerTool("particle_authoring_guide", {
    description: "Return embedded Snowstorm and Blockbuster 1.12 authoring guidance. Request one topic to conserve context, or omit topic for the full guide.",
    inputSchema: z.object({ topic: z.enum(authoringTopics).optional() }).default({})
  }, async ({ topic }) => jsonResult({ topic: topic ?? "all", topics: authoringTopics, guide: authoringGuideFor(topic) }));

  server.registerTool("particle_design_brief", {
    description: "Convert an effect role into a compact Snowstorm/Blockbuster design brief, template recommendation, component direction and verification checklist.",
    inputSchema: z.object({
      role: z.enum(["impact", "aura", "trail", "shockwave", "smoke"]),
      durationSeconds: z.number().positive().max(120).optional(),
      attached: z.boolean().default(false)
    })
  }, async ({ role, durationSeconds, attached }) => jsonResult(designBrief(role, durationSeconds, attached)));

  server.registerTool("video_list", {
    description: "List MCP-managed reference videos. Use video_import to copy a user-provided video into this directory before analysis.",
    inputSchema: z.object({}).default({})
  }, async () => jsonResult({ root: config.referenceVideosRoot, videos: await videos.list() }));

  server.registerTool("video_import", {
    description: "Copy an external video into the MCP-managed reference-video directory. Use the returned file value with video_analyze or video_extract_frames. Existing files are never overwritten.",
    inputSchema: z.object({ sourcePath: z.string().min(1), name: z.string().min(1).optional() })
  }, async ({ sourcePath, name }) => jsonResult(await videos.import(sourcePath, name)));

  server.registerTool("video_analyze", {
    description: "Detect visual scene changes, sample a reference video, write JPEG frames plus a contact sheet and manifest with requested and decoded timecodes. Returns the contact sheet inline for vision-capable AI review.",
    inputSchema: z.object({
      file: z.string(),
      samples: z.number().int().min(4).max(24).default(12),
      sceneThreshold: z.number().min(0.05).max(1).default(0.3)
    })
  }, async ({ file, samples, sceneThreshold }) => {
    const result = await videos.analyze(file, { samples, sceneThreshold });
    const contactSheet = await readFile(result.contactSheet);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ ...result, note: "These frames are local visual evidence. Interpret VFX layers with the authoring guide, then validate the recreated particle in Snowstorm and Minecraft." }, null, 2) },
        { type: "image" as const, data: contactSheet.toString("base64"), mimeType: "image/jpeg" }
      ]
    };
  });

  server.registerTool("video_extract_frames", {
    description: "Extract decoded JPEG frames at requested seconds or HH:MM:SS.mmm targets. The response records each requested target and the decoded frame PTS. Returns a contact sheet plus a manifest and individual frame paths.",
    inputSchema: z.object({
      file: z.string(),
      timecodes: z.array(z.union([z.string(), z.number().nonnegative()])).min(1).max(24)
    })
  }, async ({ file, timecodes }) => {
    const result = await videos.extractAtTimecodes(file, timecodes);
    const contactSheet = await readFile(result.contactSheet);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
        { type: "image" as const, data: contactSheet.toString("base64"), mimeType: "image/jpeg" }
      ]
    };
  });

  return server;
}

const handle = serveStdio(createMcpServer);
const close = async () => {
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
