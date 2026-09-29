import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { ProjectRegistry } from "./config.js";
import {
  buildTextureSheet,
  generateTextureAsset,
  importTextureAsset,
  listTextures,
  textureFlipbookAtlas
} from "./texture.js";
import { openDesktop } from "./desktop-launcher.js";
import { applyPatch, assertJsonWithinLimits, ParticleBomError, ParticleStore, summarizeParticle } from "./particle-store.js";
import { renderParticle } from "./renderer.js";
import { renderScene } from "./scene-renderer.js";
import { createTemplate, templateNames } from "./templates.js";
import type { JsonObject, JsonPatchOperation } from "./types.js";
import { validateParticle } from "./validator.js";
import { validatePackage } from "./package-validator.js";
import { patchParticlesBatch, queryParticles } from "./particle-service.js";
import { inspectSpellTimeline, retimeSpell } from "./magicspells.js";
import { mergeSelectors } from "./selectors-merge.js";
import { probeParticle } from "./molang-probe.js";
import { authoringGuideFor, authoringTopics, designBrief } from "./authoring-guide.js";
import { VideoAnalyzer } from "./video.js";
import { sceneCameraSchema } from "./input-schema.js";
import { TEXTURE_PRIMITIVES } from "./texture-generator.js";

function asObject(value: unknown, name: string): JsonObject {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${name} must be a JSON object.`);
  return value as JsonObject;
}

function jsonResult(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], isError };
}

class ProjectSwitchGate {
  private readers = 0;
  private writer = false;
  private readonly queue: Array<{ mode: "read" | "write"; resolve: () => void }> = [];

  async withRead<T>(operation: () => T | Promise<T>): Promise<T> {
    await this.acquire("read");
    try {
      return await operation();
    } finally {
      this.release("read");
    }
  }

  async withWrite<T>(operation: () => T | Promise<T>): Promise<T> {
    await this.acquire("write");
    try {
      return await operation();
    } finally {
      this.release("write");
    }
  }

  private acquire(mode: "read" | "write"): Promise<void> {
    if (mode === "read" && !this.writer && !this.queue.some((waiter) => waiter.mode === "write")) {
      this.readers += 1;
      return Promise.resolve();
    }
    if (mode === "write" && !this.writer && this.readers === 0 && this.queue.length === 0) {
      this.writer = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push({ mode, resolve }));
  }

  private release(mode: "read" | "write"): void {
    if (mode === "read") this.readers -= 1;
    else this.writer = false;
    if (this.writer || this.readers > 0 || this.queue.length === 0) return;

    if (this.queue[0]!.mode === "write") {
      this.writer = true;
      this.queue.shift()!.resolve();
      return;
    }
    while (this.queue[0]?.mode === "read") {
      this.readers += 1;
      this.queue.shift()!.resolve();
    }
  }
}

const patchOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["add", "replace", "test"]), path: z.string().max(512), value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: z.string().max(512) })
]);
const particleFileSchema = z.string().max(512).refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return normalized.endsWith(".particle.json")
    && !normalized.startsWith("/")
    && !/^[A-Za-z]:/.test(normalized)
    && normalized.split("/").every((part) => part && part !== "." && part !== "..");
}, "Particle file must be a canonical relative .particle.json path.");
const boundedBindingsSchema = z.record(z.string().max(64), z.string().max(512)).refine((value) => Object.keys(value).length <= 64, "At most 64 bindings are allowed.");
const boundedSelectionSchema = z.record(z.string().max(64), z.string().max(512)).refine((value) => Object.keys(value).length <= 32, "At most 32 selected fields are allowed.");
const particleDocumentSchema = z.record(z.string().max(256), z.unknown());

export async function createMcpServer(configPath?: string): Promise<McpServer> {
  const registry = await ProjectRegistry.load(configPath);
  let config = registry.currentConfig;
  let store = new ParticleStore(config);
  let videos = new VideoAnalyzer(config);
  const server = new McpServer(
    { name: "snowstorm-mcp", version: "0.2.0" },
    {
      instructions: "Create and edit Minecraft Blockbuster 1.12 particle JSON safely. Inspect before editing. Do not remove blockbuster:* components unless explicitly requested. Rendered images prove Snowstorm's preview only, never Minecraft playback."
    }
  );
  const switchGate = new ProjectSwitchGate();
  const registerTool = new Proxy(server.registerTool.bind(server), {
    apply(target, thisArg, args: unknown[]) {
      const [name, config, handler] = args as [string, unknown, (...handlerArgs: unknown[]) => unknown];
      const guardedHandler = (...handlerArgs: unknown[]) => name === "project_use"
        ? switchGate.withWrite(() => handler.apply(thisArg, handlerArgs))
        : switchGate.withRead(async () => {
          registry.assertCurrent();
          return await handler.apply(thisArg, handlerArgs);
        });
      return Reflect.apply(target, thisArg, [name, config, guardedHandler]);
    }
  });
  server.registerTool = registerTool;

  server.registerTool("project_list", {
    description: "List configured project keys and identify the active in-memory project.",
    inputSchema: z.object({}).default({})
  }, async () => {
    return jsonResult({ activeProject: registry.activeProject, projects: registry.list() });
  });

  server.registerTool("project_use", {
    description: "Switch the active in-memory project without restarting the MCP server.",
    inputSchema: z.object({ name: z.string().min(1).max(128) })
  }, async ({ name }) => {
    const nextConfig = await registry.use(name);
    config = nextConfig;
    store = new ParticleStore(nextConfig);
    videos = new VideoAnalyzer(nextConfig);
    return jsonResult({ activeProject: registry.activeProject, projectName: config.projectName, particlesRoot: config.particlesRoot });
  });

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
    inputSchema: z.object({ file: particleFileSchema, includeJson: z.boolean().default(false) })
  }, async ({ file, includeJson }) => {
    const source = await store.readRaw(file);
    return jsonResult({ digest: source.digest, summary: summarizeParticle(source.document, file), document: includeJson ? source.document : undefined });
  });

  server.registerTool("particle_query", {
    description: "Inspect several particles with filters and caller-selected JSON Pointer fields. Collapses values common to every result to reduce tokens.",
    inputSchema: z.object({
      files: z.array(particleFileSchema).max(100).optional(),
      nameContains: z.string().max(256).optional(),
      identifierContains: z.string().max(256).optional(),
      texture: z.string().max(512).optional(),
      components: z.array(z.string().max(256)).max(20).optional(),
      select: boundedSelectionSchema.optional(),
      collapseCommon: z.boolean().default(true)
    })
  }, async (options) => {
    assertJsonWithinLimits(options, "particle_query request");
    return jsonResult(await queryParticles(store, options));
  });

  server.registerTool("particle_create", {
    description: "Create a new particle from a compact starter template or a supplied JSON document. Existing files are never overwritten by this tool.",
    inputSchema: z.object({
      file: particleFileSchema,
      identifier: z.string().min(1).optional(),
      texture: z.string().min(1).optional(),
      template: z.enum(templateNames).optional(),
      document: particleDocumentSchema.optional(),
      dryRun: z.boolean().default(false)
    }).refine((value) => value.document !== undefined || Boolean(value.identifier && value.texture), "Supply document, or both identifier and texture.")
  }, async ({ file, identifier, texture, template, document, dryRun }) => {
    assertJsonWithinLimits({ file, identifier, texture, template, document, dryRun }, "particle_create request");
    if (await store.exists(file)) throw new Error(`Refusing to overwrite existing particle: ${file}`);
    const created = document !== undefined ? asObject(document, "document") : createTemplate(template ?? "burst", identifier!, texture!);
    assertJsonWithinLimits(created, "Particle document");
    const validation = await validateParticle(created, config, file);
    if (!validation.valid) return jsonResult({ created: false, validation }, true);
    if (dryRun) return jsonResult({ created: false, dryRun: true, validation });
    const write = await store.create(file, created);
    return jsonResult({ created: true, write, validation });
  });

  server.registerTool("particle_patch", {
    description: "Apply RFC 6902 add, replace, remove, and test operations to one particle. Uses an expected SHA-256 digest to avoid overwriting an externally changed file. Send numbers as JSON numbers: replacing a numeric field with a bare numeric string such as \"9\" is refused, because it is indistinguishable from a Molang literal once written.",
    inputSchema: z.object({
      file: particleFileSchema,
      operations: z.array(patchOperationSchema).min(1).max(100),
      expectedDigest: z.string().length(64),
      dryRun: z.boolean().default(false)
    })
  }, async ({ file, operations, expectedDigest, dryRun }) => {
    assertJsonWithinLimits({ file, operations, expectedDigest, dryRun }, "particle_patch request");
    const source = await store.readRaw(file);
    const patched = applyPatch(source.document, operations as JsonPatchOperation[]);
    const validation = await validateParticle(patched, config, file);
    if (!validation.valid) return jsonResult({ updated: false, validation }, true);
    if (dryRun) return jsonResult({ updated: false, dryRun: true, digest: source.digest, validation });
    const write = await store.write(file, patched, expectedDigest);
    return jsonResult({ updated: true, write, validation });
  });

  server.registerTool("particle_patch_batch", {
    description: "Validate and apply RFC 6902 patches as one preflighted batch with coordinated best-effort rollback. Dry-run is the default; every target requires its inspection digest.",
    inputSchema: z.object({
      targets: z.array(z.object({
        file: particleFileSchema,
        expectedDigest: z.string().length(64),
        operations: z.array(patchOperationSchema).max(100).optional()
      })).min(1).max(64),
      commonOperations: z.array(patchOperationSchema).max(100).optional(),
      bindings: boundedBindingsSchema.optional(),
      dryRun: z.boolean().default(true)
    })
  }, async ({ targets, commonOperations, bindings, dryRun }) => {
    assertJsonWithinLimits({ targets, commonOperations, bindings, dryRun }, "particle_patch_batch request");
    const result = await patchParticlesBatch(store, config, {
      targets: targets.map((target) => ({ ...target, operations: target.operations as JsonPatchOperation[] | undefined })),
      commonOperations: commonOperations as JsonPatchOperation[] | undefined,
      bindings,
      dryRun
    });
    return jsonResult(result, !result.valid);
  });

  server.registerTool("particle_validate", {
    description: "Validate Bedrock/Snowstorm structure, Blockbuster-compatible components, texture resolution, collision assumptions, and finite lifetime risks.",
    inputSchema: z.object({ file: particleFileSchema })
  }, async ({ file }) => {
    try {
      return jsonResult(await validateParticle(await store.read(file), config, file));
    } catch (error) {
      if (!(error instanceof ParticleBomError)) throw error;
      return jsonResult({
        valid: false,
        issues: [{ severity: "error", code: "bom", message: error.message, path: file }]
      }, true);
    }
  });

  server.registerTool("particle_verify_package", {
    description: "Validate the full package graph: particles, PNG/UV assets, selectors, MagicSpells helpers, cumulative timing, anchors and helper durations.",
    inputSchema: z.object({
      mainSpell: z.string().max(256).optional(),
      ticksPerSecond: z.number().int().min(1).max(100).default(20),
      detail: z.enum(["summary", "full"]).default("summary")
    }).default({ ticksPerSecond: 20, detail: "summary" })
  }, async (options) => {
    const validation = await validatePackage(config, store, options);
    return jsonResult(validation, !validation.valid);
  });

  server.registerTool("spell_timeline_inspect", {
    description: "Parse the configured MagicSpells YAML strictly and return absolute helper starts for one parent MultiSpell.",
    inputSchema: z.object({ mainSpell: z.string().max(256).optional(), ticksPerSecond: z.number().int().min(1).max(100).default(20) })
  }, async ({ mainSpell, ticksPerSecond }) => {
    const timeline = await inspectSpellTimeline(config, mainSpell, ticksPerSecond);
    return jsonResult({
      mainSpell: timeline.mainSpell,
      ticksPerSecond,
      digest: timeline.digest,
      startsTicks: timeline.starts,
      startsSeconds: Object.fromEntries(Object.entries(timeline.starts).map(([helper, ticks]) => [helper, ticks / ticksPerSecond])),
      occurrences: timeline.occurrences,
      endTicks: timeline.endTicks,
      order: timeline.order,
      issues: timeline.issues
    }, timeline.issues.some((issue) => issue.severity === "error"));
  });

  server.registerTool("spell_retime", {
    description: "Retiming-only MagicSpells edit. Rebuild one MultiSpell sequence from absolute helper starts while preserving the rest of the YAML. Dry-run by default.",
    inputSchema: z.object({
      mainSpell: z.string().max(256),
      expectedDigest: z.string().length(64),
      starts: z.record(z.string().max(256), z.number().nonnegative()).refine((value) => Object.keys(value).length <= 256, "At most 256 starts are allowed."),
      unit: z.enum(["ticks", "seconds"]).default("seconds"),
      ticksPerSecond: z.number().int().min(1).max(100).default(20),
      dryRun: z.boolean().default(true)
    })
  }, async (options) => {
    assertJsonWithinLimits(options, "spell_retime request");
    return jsonResult(await retimeSpell(config, options));
  });

  server.registerTool("selectors_merge", {
    description: "Merge the configured selectors.json additions fragment into an instance selectors file. Dry-run by default; conflicts are reported and never replace existing selectors. Live writes require write=true, dryRun=false, and the target's expected SHA-256 digest.",
    inputSchema: z.object({
      instanceFile: z.string().min(1).max(2048).optional(),
      dryRun: z.boolean().default(true),
      expectedDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      write: z.boolean().default(false)
    })
  }, async (options) => {
    assertJsonWithinLimits(options, "selectors_merge request");
    return jsonResult(await mergeSelectors(config, options, () => registry.assertCurrent()));
  });

  server.registerTool("particle_render", {
    description: "Render one particle through Snowstorm's local WebGL preview. Returns a PNG inline and optionally writes GIF or MP4 artifacts. This is not proof of the Minecraft render.",
    inputSchema: z.object({
      file: particleFileSchema,
      durationSeconds: z.number().positive().max(30).default(1.5),
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

  server.registerTool("particle_render_scene", {
    description: "Render a deterministic multi-layer Snowstorm scene on an absolute timeline. Returns a contact sheet inline plus GIF/MP4 and finite-lifetime evidence on disk. Snowstorm depth-writes transparent particles, which stencils overlapping quads inside one emitter with hard straight edges that do not occur in Minecraft; pass depthWrite: false for a faithful image, and grid: false to hide the ground grid and origin axes that only exist in the preview. Use shots for a multi-cut camera, solo to attribute a composited artefact to one layer, and a layer's overrides to test a variant that is never written to disk.",
    inputSchema: z.object({
      layers: z.array(z.object({
        file: particleFileSchema,
        startSeconds: z.number().nonnegative(),
        position: z.tuple([z.number(), z.number(), z.number()]).optional(),
        overrides: z.array(patchOperationSchema).max(100).optional()
      })).max(64).optional(),
      mainSpell: z.string().optional(),
      renderStart: z.number().nonnegative(),
      renderEnd: z.number().positive(),
      camera: sceneCameraSchema.optional(),
      shots: z.array(z.object({
        startSeconds: z.number().nonnegative(),
        endSeconds: z.number().positive(),
        camera: sceneCameraSchema
      })).max(32).optional(),
      sampleTimes: z.array(z.number().nonnegative()).max(24).optional(),
      solo: particleFileSchema.optional(),
      grid: z.boolean().default(true),
      depthWrite: z.boolean().default(false),
      fps: z.number().int().min(1).max(30).default(10),
      width: z.number().int().min(320).max(1920).default(960),
      height: z.number().int().min(240).max(1080).default(540),
      format: z.enum(["png", "gif", "mp4"]).default("gif"),
      seed: z.number().int().default(1)
    })
  }, async (options) => {
    assertJsonWithinLimits(options, "particle_render_scene request");
    const result = await renderScene(store, config, {
      ...options,
      layers: options.layers?.map((layer) => ({ ...layer, overrides: layer.overrides as JsonPatchOperation[] | undefined })),
      shots: options.shots?.map((shot) => ({
        startSeconds: shot.startSeconds,
        endSeconds: shot.endSeconds,
        camera: { position: shot.camera.position as [number, number, number], target: shot.camera.target as [number, number, number] }
      }))
    });
    const image = await readFile(result.artifacts.contactSheet);
    return { content: [
      { type: "text" as const, text: JSON.stringify(result) },
      { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" }
    ], isError: !result.valid };
  });

  server.registerTool("particle_probe", {
    description: "Evaluate selected numeric or Molang fields at explicit particle ages and assert invariants over them. `select` maps an alias of your choosing to a JSON Pointer: {\"size\": \"/particle_effect/components/minecraft:particle_appearance_billboard/size\"}. An assertion then references that alias, never the pointer: {\"field\": \"size\", \"sampleIndexes\": [0,1,2], \"metric\": \"length\", \"direction\": \"increasing\"}. Use metric \"length\" or \"distance\" to reduce a vector, minValue/maxValue for an absolute bound such as a crest radius that must not swallow the camera, and combine to assert across fields such as count x alpha staying under a whiteout threshold.",
    inputSchema: z.object({
      file: particleFileSchema,
      select: boundedSelectionSchema,
      samples: z.array(z.object({
        age: z.number().nonnegative(),
        lifetime: z.number().positive().optional(),
        emitterAge: z.number().nonnegative().optional(),
        random: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
        variables: z.record(z.string().max(128), z.number()).refine((value) => Object.keys(value).length <= 64, "At most 64 variables are allowed.").optional()
      })).min(1).max(32),
      assertions: z.array(z.object({
        field: z.string().optional(),
        combine: z.object({
          op: z.enum(["multiply", "divide", "add", "subtract", "min", "max"]),
          fields: z.array(z.string().max(64)).min(1).max(8)
        }).optional(),
        sampleIndexes: z.array(z.number().int().nonnegative()).min(1).max(32),
        metric: z.enum(["value", "length", "distance"]),
        direction: z.enum(["increasing", "decreasing"]).optional(),
        center: z.array(z.number()).optional(),
        minRatio: z.number().optional(),
        maxRatio: z.number().optional(),
        minValue: z.number().optional(),
        maxValue: z.number().optional()
      }).refine((value) => (value.field === undefined) !== (value.combine === undefined), "Supply exactly one of field or combine.")
      ).max(20).optional(),
      seed: z.number().int().default(1)
    })
  }, async (options) => {
    assertJsonWithinLimits(options, "particle_probe request");
    const result = await probeParticle(store, config, options);
    return jsonResult(result, !result.valid);
  });

  server.registerTool("particle_open_desktop", {
    description: "Builds must already exist. Opens one particle in the local secure Electron Snowstorm editor; its Save safely control preserves Blockbuster extensions.",
    inputSchema: z.object({ file: particleFileSchema })
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

  const textureBankSelectionSchema = z.union([
    z.number().int().min(0).max(15),
    z.string().min(1).max(4096)
  ]);

  server.registerTool("texture_generate", {
    description: "Generate a named PNG texture primitive and safely persist it in the project resource pack, or in one configured shared bank (bank is a zero-based index or exact configured root). The response includes the exact address/path, SHA-256 and decoded pixel metrics (nonZeroCoverage is alpha > 0; brightCoverage is alpha-weighted luminance >= 0.1). This is a generated asset, not proof of Minecraft playback. soft_lens enforces at least 35% bright-frame coverage.",
    inputSchema: z.object({
      texture: z.string().min(3).max(512),
      primitive: z.enum(TEXTURE_PRIMITIVES),
      bank: textureBankSelectionSchema.optional(),
      width: z.number().int().min(1).max(8192).optional(),
      height: z.number().int().min(1).max(8192).optional(),
      seed: z.number().int().min(0).max(0xffff_ffff).optional(),
      tint: z.string().regex(/^#[\da-f]{6}$/i).optional(),
      intensity: z.number().positive().max(1).optional()
    })
  }, async (options) => {
    assertJsonWithinLimits(options, "texture_generate request");
    return jsonResult(await generateTextureAsset(config, options, () => registry.assertCurrent()));
  });

  server.registerTool("texture_list", {
    description: "Recursively catalogue project and configured shared-bank PNGs, project-first and deduplicated case-insensitively. Returns the winning source/root, shadowed sources, decoded alpha/coverage metrics (brightCoverage counts alpha-weighted luminance >= 0.1), and particles that use each texture.",
    inputSchema: z.object({
      nameContains: z.string().max(256).optional(),
      minCoverage: z.number().min(0).max(1).optional(),
      hasAlpha: z.boolean().optional(),
      width: z.number().int().min(1).max(8192).optional(),
      height: z.number().int().min(1).max(8192).optional(),
      usedBy: z.string().min(1).max(512).optional(),
      limit: z.number().int().min(1).max(200).default(60)
    }).default({ limit: 60 })
  }, async (filters) => {
    assertJsonWithinLimits(filters, "texture_list request");
    return jsonResult(await listTextures(config, await store.list(), filters));
  });

  server.registerTool("texture_import", {
    description: "Validate and copy an external PNG into a configured shared texture bank. Select the bank by zero-based sharedTextureBanks index or exact configured root; name, when supplied, is a namespace:path texture address (otherwise imported:<source-basename> is used). Existing destinations are never overwritten.",
    inputSchema: z.object({
      sourcePath: z.string().min(1).max(4096),
      bank: textureBankSelectionSchema,
      name: z.string().min(3).max(512).optional()
    })
  }, async (options) => {
    assertJsonWithinLimits(options, "texture_import request");
    return jsonResult(await importTextureAsset(config, options, () => registry.assertCurrent()));
  });

  server.registerTool("flipbook_atlas", {
    description: "Calculate Bedrock UV and flipbook fields from the actual dimensions of a resolved project/bank PNG; includes the winning source/root and any shadowed banks.",
    inputSchema: z.object({
      texture: z.string().min(3).max(512),
      columns: z.number().int().min(1).max(8192),
      rows: z.number().int().min(1).max(8192),
      direction: z.enum(["horizontal", "vertical"]).default("vertical"),
      startColumn: z.number().int().min(0).max(8191).optional(),
      startRow: z.number().int().min(0).max(8191).optional(),
      frameCount: z.number().int().min(1).max(65536).optional(),
      framesPerSecond: z.number().positive().max(1000).default(10),
      stretchToLifetime: z.boolean().default(true)
    })
  }, async ({ texture, ...options }) => {
    assertJsonWithinLimits({ texture, ...options }, "flipbook_atlas request");
    return jsonResult(await textureFlipbookAtlas(texture, config, options));
  });

  server.registerTool("texture_contact_sheet", {
    description: "Render up to 16 real particle PNGs on a checkerboard with their declared dimensions, so alpha, contour and resolution can be judged before a scene render. A hard straight contour on a tile is the artwork's own alpha, not a compositing artefact; this is the only view that separates the two.",
    inputSchema: z.object({
      textures: z.array(z.string().min(1).max(512)).min(1).max(16)
    })
  }, async ({ textures }) => {
    const result = await buildTextureSheet(config, textures);
    const image = await readFile(result.sheet);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ ...result, entries: result.entries.map(({ dataUrl, ...entry }) => entry) }, null, 2) },
        { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" }
      ]
    };
  });

  server.registerTool("video_list", {
    description: "List MCP-managed reference videos. Use video_import to copy a user-provided video into this directory before analysis.",
    inputSchema: z.object({}).default({})
  }, async () => jsonResult({ root: config.referenceVideosRoot, videos: await videos.list() }));

  server.registerTool("video_import", {
    description: "Copy an external video into the MCP-managed reference-video directory. Use the returned file value with video_analyze or video_extract_frames. Existing files are never overwritten.",
    inputSchema: z.object({ sourcePath: z.string().min(1).max(512), name: z.string().min(1).optional() })
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

  server.registerTool("video_audio_transients", {
    description: "Rank high-pass audio attacks in a bounded reference-video window. Scores are mixed-track candidates, not isolated sound-effect recognition.",
    inputSchema: z.object({
      file: z.string().min(1).max(512),
      startSeconds: z.number().nonnegative().default(0),
      durationSeconds: z.number().positive().max(60).default(10),
      maxResults: z.number().int().min(1).max(64).default(24),
      minimumSpacingSeconds: z.number().min(0.05).max(5).default(0.24),
      highPassHz: z.number().min(50).max(10_000).default(250)
    })
  }, async ({ file, startSeconds, durationSeconds, maxResults, minimumSpacingSeconds, highPassHz }) => {
    return jsonResult(await videos.audioTransients(file, { startSeconds, durationSeconds, maxResults, minimumSpacingSeconds, highPassHz }));
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

  server.registerTool("video_compare", {
    description: "Create a side-by-side MP4: reference video on the left, a Snowstorm MP4 artifact on the right, with the reference audio retained. previewPath must be inside MCP artifacts.",
    inputSchema: z.object({
      file: z.string().min(1).max(512),
      previewPath: z.string().min(1).max(512),
      referenceStartSeconds: z.number().nonnegative(),
      durationSeconds: z.number().positive().max(30),
      panelWidth: z.number().int().min(320).max(1920).default(640),
      panelHeight: z.number().int().min(240).max(1080).default(360)
    })
  }, async ({ file, previewPath, referenceStartSeconds, durationSeconds, panelWidth, panelHeight }) => {
    return jsonResult(await videos.compare(file, { previewPath, referenceStartSeconds, durationSeconds, panelWidth, panelHeight }));
  });

  return server;
}

const isEntryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isEntryPoint) {
  const handle = serveStdio(() => createMcpServer());
  const close = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
