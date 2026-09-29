import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "playwright";
import type { JsonObject, JsonPatchOperation, ProjectConfig, TimelineLayer } from "./types.js";
import type { ParticleStore } from "./particle-store.js";
import { applyPatch, numericLiteral } from "./particle-store.js";
import { inspectTexture, particleTexture, resolveTexturePath } from "./texture.js";
import { startSnowstormHost } from "./snowstorm-host.js";
import { snowstormRoot } from "./config.js";
import { validatePackage } from "./package-validator.js";
import { particleTiming, validateParticle } from "./validator.js";

export const MAX_SCENE_FRAMES = 750;
export const MAX_SCENE_RENDERED_PIXELS = 480_000_000;

export interface SceneLayer {
  file: string;
  startSeconds: number;
  position?: [number, number, number];
  /** Applied in memory only. The file on disk is never written, so a variant can be diagnosed without leaving a test particle in the delivery folder. */
  overrides?: JsonPatchOperation[];
}

export interface SceneShot {
  startSeconds: number;
  endSeconds: number;
  camera: { position: [number, number, number]; target: [number, number, number] };
}

export interface SceneRenderOptions {
  layers?: SceneLayer[];
  mainSpell?: string;
  renderStart: number;
  renderEnd: number;
  camera?: { position: [number, number, number]; target: [number, number, number] };
  shots?: SceneShot[];
  sampleTimes?: number[];
  /** Render only this particle, for attributing a composited artefact to one layer. */
  solo?: string;
  grid?: boolean;
  depthWrite?: boolean;
  fps?: number;
  width?: number;
  height?: number;
  format?: "png" | "gif" | "mp4";
  seed?: number;
}

export interface SceneRenderResult {
  valid: boolean;
  layers: number;
  frames: number;
  checks: { emits: string; finite: string; expires: string };
  overriddenLayers: string[];
  sampleTimesSource: "requested" | "derived";
  sampleTimes: number[];
  artifacts: { directory: string; preview: string; animation?: string; contactSheet: string; report: string };
  caveats: string[];
}

export function enforceSceneFrameBudget(frameCount: number, width: number, height: number): void {
  if (frameCount > MAX_SCENE_FRAMES) {
    throw new Error(`Scene render is limited to ${MAX_SCENE_FRAMES} frames. Lower fps or split the render window.`);
  }
  if (frameCount * width * height > MAX_SCENE_RENDERED_PIXELS) {
    throw new Error(`Scene render exceeds the ${MAX_SCENE_RENDERED_PIXELS.toLocaleString("en-US")} rendered-pixel budget. Lower resolution, fps, or duration.`);
  }
}

function projectRoot(config: ProjectConfig): string {
  return path.dirname(config.configPath);
}

export function cameraForTime(
  shots: SceneShot[] | undefined,
  time: number,
  fallback: { position: [number, number, number]; target: [number, number, number] }
): { position: [number, number, number]; target: [number, number, number] } {
  return shots?.find((shot) => time >= shot.startSeconds && time < shot.endSeconds)?.camera ?? fallback;
}

/**
 * Samples each layer at its own start, midpoint and tail, so the contact sheet covers
 * what the layers actually do instead of three generic window landmarks.
 */
export function deriveSampleTimes(
  layers: Array<{ startSeconds: number; lifetime: number }>,
  renderStart: number,
  renderEnd: number,
  limit = 24
): number[] {
  const candidates = [renderStart, renderEnd];
  for (const layer of layers) {
    for (const fraction of [0, 0.5, 0.9]) candidates.push(layer.startSeconds + layer.lifetime * fraction);
  }
  const inside = [...new Set(candidates
    .filter((time) => time >= renderStart && time <= renderEnd)
    .map((time) => Number(time.toFixed(3))))].sort((left, right) => left - right);
  if (inside.length <= limit) return inside;
  const thinned: number[] = [];
  for (let index = 0; index < limit; index += 1) thinned.push(inside[Math.round(index * (inside.length - 1) / (limit - 1))]!);
  return [...new Set(thinned)];
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let error = "";
    const timeout = setTimeout(() => child.kill(), 120_000);
    child.stderr.on("data", (chunk: Buffer) => { error = `${error}${chunk.toString()}`.slice(-16_384); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${error.slice(-1000)}`));
    });
  });
}

interface FrameEncoder {
  output: string;
  write(frame: Buffer): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

function createFrameEncoder(format: "gif" | "mp4", fps: number, artifactDirectory: string): FrameEncoder {
  const output = path.join(artifactDirectory, format === "gif" ? "scene.gif" : "scene.mp4");
  const encode = format === "gif"
    ? ["-filter_complex", "split[s0][s1];[s0]palettegen=stats_mode=single[p];[s1][p]paletteuse=new=1", output]
    : ["-c:v", "libx264", "-pix_fmt", "yuv420p", output];
  const child = spawn("ffmpeg", ["-y", "-nostdin", "-f", "image2pipe", "-vcodec", "png", "-framerate", String(fps), "-i", "pipe:0", ...encode], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let error = "";
  let settled = false;
  let completeResolve: () => void;
  let completeReject: (error: Error) => void;
  const complete = new Promise<void>((resolve, reject) => {
    completeResolve = resolve;
    completeReject = reject;
  });
  void complete.catch(() => undefined);
  const settle = (failure?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    failure ? completeReject(failure) : completeResolve();
  };
  const timeout = setTimeout(() => {
    child.kill();
    settle(new Error("Scene animation encoding exceeded 240000ms."));
  }, 240_000);
  child.stderr.on("data", (chunk: Buffer) => { error = `${error}${chunk.toString()}`.slice(-16_384); });
  child.once("error", (failure) => settle(failure));
  child.once("exit", (code) => settle(code === 0 ? undefined : new Error(`ffmpeg failed (${code}): ${error.slice(-1000)}`)));
  return {
    output,
    write: (frame) => new Promise((resolve, reject) => child.stdin.write(frame, (failure) => failure ? reject(failure) : resolve())),
    finish: async () => {
      child.stdin.end();
      await complete;
    },
    abort: async () => {
      if (!settled) {
        child.kill();
        settle(new Error("Scene animation encoding was aborted."));
      }
      await complete.catch(() => undefined);
    }
  };
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms.`)), milliseconds);
    operation.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); }
    );
  });
}

export function enforceRenderBudget(document: JsonObject, file: string, lifetime: number): number {
  if (lifetime > 300) throw new Error(`${file} exceeds the 300 second scene-simulation lifetime limit.`);
  const effect = document.particle_effect as JsonObject | undefined;
  const components = effect?.components as JsonObject | undefined;
  const instant = components?.["minecraft:emitter_rate_instant"] as JsonObject | undefined;
  const steady = components?.["minecraft:emitter_rate_steady"] as JsonObject | undefined;
  if (components?.["minecraft:emitter_rate_manual"]) throw new Error(`${file} uses manual emission, which cannot be bounded for deterministic scene rendering.`);
  const bounded = new Map<string, number>();
  for (const [name, value] of [["num_particles", instant?.num_particles], ["spawn_rate", steady?.spawn_rate], ["max_particles", steady?.max_particles]] as const) {
    if (value === undefined) continue;
    // A bare numeric string is still a bounded Molang literal, so accept it rather than
    // refusing to render a file that is semantically fine.
    const literal = numericLiteral(value);
    if (literal === null) throw new Error(`${file} uses expression-valued ${name}, which cannot be bounded for scene rendering.`);
    bounded.set(name, literal);
  }
  const instantCount = bounded.get("num_particles") ?? 0;
  const spawnRate = bounded.get("spawn_rate") ?? 0;
  const maximum = bounded.get("max_particles") ?? spawnRate * lifetime;
  if (instantCount > 10_000 || maximum > 10_000) throw new Error(`${file} exceeds the 10,000 particle scene-simulation budget.`);
  return Math.max(1, instantCount, maximum);
}

async function textureDataUrl(document: JsonObject, config: ProjectConfig): Promise<string> {
  const texture = particleTexture(document);
  if (!texture) throw new Error("Particle has no texture address.");
  await inspectTexture(texture, config);
  return `data:image/png;base64,${(await readFile(resolveTexturePath(texture, config))).toString("base64")}`;
}

async function loadConfig(page: Page, name: string, raw: string, texture: string): Promise<void> {
  await page.evaluate("([source, url]) => loadFileFromParentEffect(source, url)", [raw, texture]);
  await page.waitForTimeout(30);
  await page.evaluate(async ({ name, source, url }) => {
    const root = window as typeof window & {
      Emitter: any;
      __engine: any;
      __configs: Record<string, any>;
    };
    root.Emitter.stopLoop();
    root.Emitter.start();
    const config = new root.__engine.Config(root.Emitter.scene);
    config.setFromJSON(JSON.parse(source));
    config.texture = root.Emitter.config.texture.clone();
    const image = new Image();
    image.src = url;
    await image.decode();
    config.texture.image = image;
    config.texture.needsUpdate = true;
    root.__configs[name] = config;
    root.Emitter.stopLoop();
  }, { name, source: raw, url: texture });
}

async function resolveLayers(store: ParticleStore, config: ProjectConfig, options: SceneRenderOptions): Promise<SceneLayer[]> {
  if (options.layers?.length) return options.layers;
  const packageResult = await validatePackage(config, store, { mainSpell: options.mainSpell, detail: "full" });
  if (!packageResult.valid) throw new Error(`Package graph is invalid: ${packageResult.errors.map((entry) => entry.message).join("; ")}`);
  return (packageResult.layers ?? [])
    .filter((layer: TimelineLayer) => layer.file && layer.startSeconds <= options.renderEnd && (layer.latestParticleEndSeconds ?? Number.POSITIVE_INFINITY) >= options.renderStart)
    .map((layer: TimelineLayer) => {
      const values = layer.relativeOffset?.split(",").map((value) => Number(value.trim()));
      const position = values?.length === 3 && values.every(Number.isFinite) ? values as [number, number, number] : undefined;
      return { file: layer.file!, startSeconds: layer.startSeconds, position };
    });
}

export async function renderScene(store: ParticleStore, config: ProjectConfig, options: SceneRenderOptions): Promise<SceneRenderResult> {
  const fps = options.fps ?? 10;
  const width = options.width ?? 960;
  const height = options.height ?? 540;
  const format = options.format ?? "gif";
  if (options.renderStart < 0 || options.renderEnd <= options.renderStart || options.renderEnd - options.renderStart > 30) throw new Error("Render window must be positive and at most 30 seconds.");
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error("fps must be an integer from 1 to 30.");
  const frameCount = Math.floor((options.renderEnd - options.renderStart) * fps) + 1;
  enforceSceneFrameBudget(frameCount, width, height);
  const allLayers = await resolveLayers(store, config, options);
  const requestedLayers = options.solo ? allLayers.filter((layer) => layer.file === options.solo) : allLayers;
  if (!requestedLayers.length) throw new Error(options.solo ? `No layer matches solo '${options.solo}'.` : "Scene render requires 1 to 64 layers.");
  if (requestedLayers.length > 64) throw new Error("Scene render requires 1 to 64 layers.");
  const sources = new Map<string, { raw: string; document: JsonObject; lifetime: number; maximumParticles: number }>();
  let decodedTextureBytes = 0;
  for (const [index, layer] of requestedLayers.entries()) {
    const configName = layer.overrides?.length ? `${layer.file}#${index}` : layer.file;
    if (sources.has(configName)) continue;
    const source = await store.readRaw(layer.file);
    const document = layer.overrides?.length ? applyPatch(source.document, layer.overrides) : source.document;
    if (layer.overrides?.length) {
      const validation = await validateParticle(document, config, layer.file);
      if (!validation.valid) throw new Error(`Override for ${layer.file} is invalid: ${validation.issues.filter((entry) => entry.severity === "error").map((entry) => entry.message).join("; ")}`);
    }
    const timing = particleTiming(document);
    if (timing.emitterSeconds === null || timing.particleSeconds === null) throw new Error(`${layer.file} needs numeric finite lifetimes for scene verification.`);
    const lifetime = timing.emitterSeconds + timing.particleSeconds;
    const maximumParticles = enforceRenderBudget(document, layer.file, lifetime);
    const texture = particleTexture(document);
    if (!texture) throw new Error(`${layer.file} has no texture address.`);
    const metadata = await inspectTexture(texture, config);
    decodedTextureBytes += metadata.width * metadata.height * 4;
    if (decodedTextureBytes > 256 * 1024 * 1024) throw new Error("Scene exceeds the aggregate 256 MiB decoded-texture budget.");
    sources.set(configName, {
      raw: layer.overrides?.length ? JSON.stringify(document) : source.raw,
      document,
      lifetime,
      maximumParticles
    });
  }
  const layers = requestedLayers
    .map((layer, index) => ({ ...layer, id: index, configName: layer.overrides?.length ? `${layer.file}#${index}` : layer.file }))
    .filter((layer) => layer.startSeconds <= options.renderEnd && layer.startSeconds + sources.get(layer.configName)!.lifetime >= options.renderStart);
  if (!layers.length) throw new Error("No requested layer is active in the render window.");
  const aggregateParticleTicks = layers.reduce((total, layer) => {
    const source = sources.get(layer.configName)!;
    return total + Math.ceil(source.lifetime * 30) * source.maximumParticles;
  }, 0);
  if (aggregateParticleTicks > 5_000_000) throw new Error("Scene exceeds the aggregate 5,000,000 particle-tick simulation budget.");
  const artifactDirectory = path.join(config.artifactsRoot, "scenes", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(artifactDirectory, { recursive: true });
  let host: Awaited<ReturnType<typeof startSnowstormHost>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let browserDeadline: NodeJS.Timeout | undefined;
  let encoder: FrameEncoder | undefined;
  let completed = false;
  const checks: Array<{ file: string; configName: string; peak: number; finite: boolean; remaining: number }> = [];
  try {
    host = await startSnowstormHost(snowstormRoot(projectRoot(config)), false, true);
    browser = await chromium.launch({ headless: true });
    const renderTimeout = Math.min(240_000, Math.max(120_000, frameCount * 320));
    browserDeadline = setTimeout(() => { void browser?.close(); }, Math.min(360_000, 120_000 + renderTimeout));
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(`${host.url}/index.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean((window as typeof window & { __preview?: unknown; __engine?: unknown }).__preview && (window as typeof window & { __engine?: unknown }).__engine));
    await page.evaluate((seed) => {
      let state = seed >>> 0;
      Math.random = () => {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
      };
      const root = window as typeof window & { __configs: Record<string, unknown>; __layers: unknown[] };
      root.__configs = {};
      root.__layers = [];
    }, options.seed ?? 1);
    const lifecycleDeadline = Date.now() + 120_000;
    for (const layer of layers) {
      if (checks.some((entry) => entry.configName === layer.configName)) continue;
      const source = sources.get(layer.configName)!;
      await loadConfig(page, layer.configName, source.raw, await textureDataUrl(source.document, config));
      const lifecycleRemaining = lifecycleDeadline - Date.now();
      if (lifecycleRemaining <= 0) throw new Error("Lifecycle verification exceeded the 120000ms scene budget.");
      const result = await withTimeout(page.evaluate(({ name, end }) => {
        const root = window as typeof window & { Emitter: any; __engine: any; __configs: Record<string, any> };
        const emitter = new root.__engine.Emitter(root.Emitter.scene, root.__configs[name], { loop_mode: "once", parent_mode: "world" });
        emitter.start();
        let peak = 0;
        let finite = true;
        for (let index = 0; index < Math.ceil((end + 0.3) * 30); index += 1) {
          emitter.tick(false);
          if (emitter.particles.length > 10_000) throw new Error("Emitter exceeded the 10,000 live-particle runtime limit.");
          peak = Math.max(peak, emitter.particles.length);
          for (const particle of emitter.particles) {
            finite = finite && [particle.position.x, particle.position.y, particle.position.z, particle.rotation].every(Number.isFinite);
            for (const attribute of Object.values(particle.geometry.attributes) as any[]) finite = finite && Array.from(attribute.array as number[]).every(Number.isFinite);
          }
        }
        const output = { peak, finite, remaining: emitter.particles.length };
        emitter.delete();
        return output;
      }, { name: layer.configName, end: source.lifetime }), Math.min(30_000, lifecycleRemaining), `Lifecycle verification for ${layer.file}`);
      checks.push({ file: layer.file, configName: layer.configName, ...result });
    }
    const positioned = layers.flatMap((layer) => layer.position ? [layer.position] : []);
    const center: [number, number, number] = positioned.length
      ? [0, 1, 2].map((axis) => positioned.reduce((sum, position) => sum + position[axis]!, 0) / positioned.length) as [number, number, number]
      : [0, 0, 0];
    const camera = options.camera ?? {
      position: [center[0] + 8, center[1] + 6, center[2] + 12] as [number, number, number],
      target: [center[0], center[1] + 1, center[2]] as [number, number, number]
    };
    await page.evaluate(({ camera, width, height }) => {
      const root = window as typeof window & { __preview: any };
      root.__preview.renderer.setSize(width, height);
      const canvas = root.__preview.renderer.domElement as HTMLCanvasElement;
      document.body.appendChild(canvas);
      Object.assign(canvas.style, { display: "block", position: "fixed", left: "0", top: "0", width: `${width}px`, height: `${height}px`, zIndex: "2147483647" });
      root.__preview.camera.aspect = width / height;
      root.__preview.camera.updateProjectionMatrix();
      root.__preview.camera.position.set(...camera.position);
      root.__preview.controls.target.set(...camera.target);
      root.__preview.controls.update();
    }, { camera, width, height });
    if (options.grid === false) {
      await page.evaluate(() => {
        const root = window as typeof window & { __preview: any };
        if (root.__preview.grid) root.__preview.grid.visible = false;
        if (root.__preview.helper) root.__preview.helper.visible = false;
      });
    }
    const requestedSampleTimes = options.sampleTimes?.length ? options.sampleTimes : undefined;
    const sampleTimesSource = requestedSampleTimes ? "requested" : "derived";
    const sampleTimes = (requestedSampleTimes ?? deriveSampleTimes(
      layers.map((layer) => ({ startSeconds: layer.startSeconds, lifetime: sources.get(layer.configName)!.lifetime })),
      options.renderStart,
      options.renderEnd
    ))
      .filter((time) => time >= options.renderStart && time <= options.renderEnd)
      .slice(0, 24);
    if (!sampleTimes.length) throw new Error("At least one sample time must fall inside the render window.");
    const sampleFrames = new Map(sampleTimes.map((time) => {
      const frame = Math.min(frameCount - 1, Math.max(0, Math.round((time - options.renderStart) * fps)));
      return [frame, options.renderStart + frame / fps];
    }));
    const sampleFrameIndexes = [...sampleFrames.keys()].sort((left, right) => left - right);
    const preview = path.join(artifactDirectory, "preview.png");
    encoder = format === "png" ? undefined : createFrameEncoder(format, fps, artifactDirectory);
    const samplePaths: string[] = [];
    const frameLayers = layers.map((layer) => ({ id: layer.id, configName: layer.configName, startSeconds: layer.startSeconds, position: layer.position }));
    for (let frame = 0; frame < frameCount; frame += 1) {
      const time = options.renderStart + frame / fps;
      await withTimeout(page.evaluate(({ layers, time, depthWrite, camera }) => {
        const root = window as typeof window & { Emitter: any; __engine: any; __configs: Record<string, any>; __layers: any[]; __preview: any; __cameraKey?: string };
        if (camera) {
          const key = `${camera.position.join(",")}|${camera.target.join(",")}`;
          if (root.__cameraKey !== key) {
            root.__preview.camera.position.set(...camera.position);
            root.__preview.controls.target.set(...camera.target);
            root.__preview.controls.update();
            root.__cameraKey = key;
          }
        }
        for (const row of layers) {
          if (row.startSeconds > time) continue;
          let entry = root.__layers.find((candidate) => candidate.id === row.id);
          if (!entry) {
            const emitter = new root.__engine.Emitter(root.Emitter.scene, root.__configs[row.configName], { loop_mode: "once", parent_mode: "world" });
            if (row.position) {
              const position = emitter.position ?? emitter.global_space?.position ?? emitter.local_space?.position ?? emitter.object?.position ?? emitter.mesh?.position;
              if (!position?.set) throw new Error(`Snowstorm emitter position API is unavailable (${Object.keys(emitter).join(", ")}).`);
              position.set(...row.position);
            }
            emitter.start();
            const age = Math.max(0, time - row.startSeconds);
            emitter.jumpTo(age);
            // Snowstorm builds its particle material without depthWrite: false. Every quad
            // of an emitter shares one unsorted BufferGeometry, so a nearer quad then
            // stencil-rejects a farther one and the winner's straight silhouette shows
            // through. Applied after jumpTo, the last call that runs updateMaterial().
            if (emitter.material && depthWrite === false) {
              emitter.material.depthWrite = false;
              emitter.material.needsUpdate = true;
            }
            entry = { id: row.id, emitter, age };
            root.__layers.push(entry);
          } else {
            const targetAge = time - row.startSeconds;
            while (entry.age + 1 / 60 < targetAge) {
              entry.emitter.tick(false);
              entry.age += 1 / 30;
            }
          }
          entry.emitter.updateFacingRotation(root.__preview.camera);
        }
        root.__preview.renderer.render(root.__preview.scene, root.__preview.camera);
      }, { layers: frameLayers, time, depthWrite: options.depthWrite, camera: options.shots?.length ? cameraForTime(options.shots, time, camera) : undefined }), 10_000, `Scene frame ${frame}`);
      const image = await page.locator("#canvas").screenshot();
      if (encoder) await encoder.write(image);
      if (sampleFrames.has(frame)) {
        const samplePath = path.join(artifactDirectory, `sample-${String(sampleFrameIndexes.indexOf(frame)).padStart(4, "0")}.png`);
        samplePaths.push(samplePath);
        await writeFile(samplePath, image);
      }
      if (frame === frameCount - 1) await writeFile(preview, image);
    }
    if (encoder) {
      await encoder.finish();
      encoder = undefined;
    }
    const sampleCount = sampleFrameIndexes.length;
    const columns = Math.min(3, sampleCount);
    const rows = Math.ceil(sampleCount / columns);
    const contactSheet = path.join(artifactDirectory, "contact-sheet.png");
    await runFfmpeg(["-framerate", "1", "-i", path.join(artifactDirectory, "sample-%04d.png"), "-vf", `tile=${columns}x${rows}:padding=4:margin=4`, "-frames:v", "1", contactSheet]);
    const animation = format === "png" ? undefined : path.join(artifactDirectory, format === "gif" ? "scene.gif" : "scene.mp4");
    const valid = checks.every((entry) => entry.peak > 0 && entry.finite && entry.remaining === 0);
    const overriddenLayers = layers.filter((layer) => layer.overrides?.length).map((layer) => layer.file);
    const report = path.join(artifactDirectory, "report.json");
    const result: SceneRenderResult = {
      valid,
      layers: layers.length,
      frames: frameCount,
      checks: {
        emits: `${checks.filter((entry) => entry.peak > 0).length}/${checks.length}`,
        finite: `${checks.filter((entry) => entry.finite).length}/${checks.length}`,
        expires: `${checks.filter((entry) => entry.remaining === 0).length}/${checks.length}`
      },
      overriddenLayers,
      sampleTimesSource,
      sampleTimes: [...sampleFrames.values()],
      artifacts: { directory: artifactDirectory, preview, animation, contactSheet, report },
      caveats: [
        "Snowstorm preview only; validate in Minecraft before shipping.",
        "Fixed-anchor composition assumes a stationary caster unless explicit layer transforms are supplied.",
        options.depthWrite === false
          ? "Particle depth writing is disabled to match Minecraft's transparent pass; this removes Snowstorm's straight-edged quad stencilling."
          : "Snowstorm depth-writes transparent particles, so overlapping quads inside one emitter stencil each other with hard straight edges. Pass depthWrite: false for a Minecraft-faithful image.",
        options.grid === false
          ? "The ground grid and origin axes are hidden; they do not exist in game."
          : "The ground grid and origin axes are drawn and do not exist in game. Pass grid: false to hide them.",
        ...(overriddenLayers.length ? [`Overridden in memory and never written: ${overriddenLayers.join(", ")}. This render is not the on-disk content of those files.`] : []),
        ...(options.solo ? [`Solo render: only ${options.solo} is composed, so the result cannot show a cross-layer artefact.`] : []),
        ...(sampleTimesSource === "derived" ? ["Sample times were derived from layer activity, not requested. Pass sampleTimes to choose them."] : [])
      ]
    };
    await writeFile(report, `${JSON.stringify({ ...result, layerChecks: checks, resolvedSampleTimes: [...sampleFrames.values()] }, null, 2)}\n`);
    await Promise.all(samplePaths.map((file) => rm(file, { force: true })));
    completed = true;
    return result;
  } finally {
    if (browserDeadline) clearTimeout(browserDeadline);
    await encoder?.abort();
    await Promise.allSettled([browser?.close(), host?.close()]);
    if (!completed) await rm(artifactDirectory, { recursive: true, force: true });
  }
}
