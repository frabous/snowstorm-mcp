import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "playwright";
import type { JsonObject, ProjectConfig, TimelineLayer } from "./types.js";
import type { ParticleStore } from "./particle-store.js";
import { inspectTexture, particleTexture, resolveTexturePath } from "./texture.js";
import { startSnowstormHost } from "./snowstorm-host.js";
import { snowstormRoot } from "./config.js";
import { validatePackage } from "./package-validator.js";
import { particleTiming } from "./validator.js";

export interface SceneLayer {
  file: string;
  startSeconds: number;
  position?: [number, number, number];
}

export interface SceneRenderOptions {
  layers?: SceneLayer[];
  mainSpell?: string;
  renderStart: number;
  renderEnd: number;
  camera?: { position: [number, number, number]; target: [number, number, number] };
  sampleTimes?: number[];
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
  artifacts: { directory: string; preview: string; animation?: string; contactSheet: string; report: string };
  caveats: string[];
}

function projectRoot(config: ProjectConfig): string {
  return path.dirname(config.configPath);
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
  for (const [name, value] of [["num_particles", instant?.num_particles], ["spawn_rate", steady?.spawn_rate], ["max_particles", steady?.max_particles]] as const) {
    if (value !== undefined && typeof value !== "number") throw new Error(`${file} uses expression-valued ${name}, which cannot be bounded for scene rendering.`);
  }
  const instantCount = typeof instant?.num_particles === "number" ? instant.num_particles : 0;
  const spawnRate = typeof steady?.spawn_rate === "number" ? steady.spawn_rate : 0;
  const maximum = typeof steady?.max_particles === "number" ? steady.max_particles : spawnRate * lifetime;
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
  if (frameCount > 300) throw new Error("Scene render is limited to 300 frames.");
  const requestedLayers = await resolveLayers(store, config, options);
  if (!requestedLayers.length || requestedLayers.length > 64) throw new Error("Scene render requires 1 to 64 layers.");
  const sources = new Map<string, Awaited<ReturnType<ParticleStore["readRaw"]>> & { lifetime: number; maximumParticles: number }>();
  let decodedTextureBytes = 0;
  for (const layer of requestedLayers) {
    if (sources.has(layer.file)) continue;
    const source = await store.readRaw(layer.file);
    const timing = particleTiming(source.document);
    if (timing.emitterSeconds === null || timing.particleSeconds === null) throw new Error(`${layer.file} needs numeric finite lifetimes for scene verification.`);
    const lifetime = timing.emitterSeconds + timing.particleSeconds;
    const maximumParticles = enforceRenderBudget(source.document, layer.file, lifetime);
    const texture = particleTexture(source.document);
    if (!texture) throw new Error(`${layer.file} has no texture address.`);
    const metadata = await inspectTexture(texture, config);
    decodedTextureBytes += metadata.width * metadata.height * 4;
    if (decodedTextureBytes > 256 * 1024 * 1024) throw new Error("Scene exceeds the aggregate 256 MiB decoded-texture budget.");
    sources.set(layer.file, { ...source, lifetime, maximumParticles });
  }
  const layers = requestedLayers
    .filter((layer) => layer.startSeconds <= options.renderEnd && layer.startSeconds + sources.get(layer.file)!.lifetime >= options.renderStart)
    .map((layer, id) => ({ ...layer, id }));
  if (!layers.length) throw new Error("No requested layer is active in the render window.");
  const aggregateParticleTicks = layers.reduce((total, layer) => {
    const source = sources.get(layer.file)!;
    return total + Math.ceil(source.lifetime * 30) * source.maximumParticles;
  }, 0);
  if (aggregateParticleTicks > 5_000_000) throw new Error("Scene exceeds the aggregate 5,000,000 particle-tick simulation budget.");
  const artifactDirectory = path.join(config.artifactsRoot, "scenes", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(artifactDirectory, { recursive: true });
  let host: Awaited<ReturnType<typeof startSnowstormHost>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let browserDeadline: NodeJS.Timeout | undefined;
  let completed = false;
  const checks: Array<{ file: string; peak: number; finite: boolean; remaining: number }> = [];
  try {
    host = await startSnowstormHost(snowstormRoot(projectRoot(config)), false, true);
    browser = await chromium.launch({ headless: true });
    browserDeadline = setTimeout(() => { void browser?.close(); }, 120_000);
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
    for (const layer of layers) {
      if (checks.some((entry) => entry.file === layer.file)) continue;
      const source = sources.get(layer.file)!;
      await loadConfig(page, layer.file, source.raw, await textureDataUrl(source.document, config));
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
      }, { name: layer.file, end: source.lifetime }), 30_000, `Lifecycle verification for ${layer.file}`);
      checks.push({ file: layer.file, ...result });
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
    const requestedSampleTimes = options.sampleTimes?.length ? options.sampleTimes : [options.renderStart, (options.renderStart + options.renderEnd) / 2, options.renderEnd];
    const sampleTimes = requestedSampleTimes
      .filter((time) => time >= options.renderStart && time <= options.renderEnd)
      .slice(0, 24);
    if (!sampleTimes.length) throw new Error("At least one sample time must fall inside the render window.");
    const sampleFrames = new Map(sampleTimes.map((time) => {
      const frame = Math.min(frameCount - 1, Math.max(0, Math.round((time - options.renderStart) * fps)));
      return [frame, options.renderStart + frame / fps];
    }));
    const sampleFrameIndexes = [...sampleFrames.keys()].sort((left, right) => left - right);
    const framePaths: string[] = [];
    const samplePaths: string[] = [];
    for (let frame = 0; frame < frameCount; frame += 1) {
      const time = options.renderStart + frame / fps;
      await withTimeout(page.evaluate(({ layers, time }) => {
        const root = window as typeof window & { Emitter: any; __engine: any; __configs: Record<string, any>; __layers: any[]; __preview: any };
        for (const row of layers) {
          if (row.startSeconds > time) continue;
          let entry = root.__layers.find((candidate) => candidate.id === row.id);
          if (!entry) {
            const emitter = new root.__engine.Emitter(root.Emitter.scene, root.__configs[row.file], { loop_mode: "once", parent_mode: "world" });
            if (row.position) {
              const position = emitter.position ?? emitter.global_space?.position ?? emitter.local_space?.position ?? emitter.object?.position ?? emitter.mesh?.position;
              if (!position?.set) throw new Error(`Snowstorm emitter position API is unavailable (${Object.keys(emitter).join(", ")}).`);
              position.set(...row.position);
            }
            emitter.start();
            const age = Math.max(0, time - row.startSeconds);
            emitter.jumpTo(age);
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
      }, { layers, time }), 10_000, `Scene frame ${frame}`);
      const framePath = path.join(artifactDirectory, `frame-${String(frame).padStart(4, "0")}.png`);
      framePaths.push(framePath);
      await page.locator("#canvas").screenshot({ path: framePath });
      if (sampleFrames.has(frame)) {
        const samplePath = path.join(artifactDirectory, `sample-${String(sampleFrameIndexes.indexOf(frame)).padStart(4, "0")}.png`);
        samplePaths.push(samplePath);
        await cp(framePath, samplePath);
      }
    }
    const preview = path.join(artifactDirectory, "preview.png");
    await cp(path.join(artifactDirectory, `frame-${String(frameCount - 1).padStart(4, "0")}.png`), preview);
    const sampleCount = sampleFrameIndexes.length;
    const columns = Math.min(3, sampleCount);
    const rows = Math.ceil(sampleCount / columns);
    const contactSheet = path.join(artifactDirectory, "contact-sheet.png");
    await runFfmpeg(["-framerate", "1", "-i", path.join(artifactDirectory, "sample-%04d.png"), "-vf", `tile=${columns}x${rows}:padding=4:margin=4`, "-frames:v", "1", contactSheet]);
    let animation: string | undefined;
    if (format === "gif") {
      animation = path.join(artifactDirectory, "scene.gif");
      await runFfmpeg(["-framerate", String(fps), "-i", path.join(artifactDirectory, "frame-%04d.png"), "-vf", "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", animation]);
    } else if (format === "mp4") {
      animation = path.join(artifactDirectory, "scene.mp4");
      await runFfmpeg(["-framerate", String(fps), "-i", path.join(artifactDirectory, "frame-%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", animation]);
    }
    const valid = checks.every((entry) => entry.peak > 0 && entry.finite && entry.remaining === 0);
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
      artifacts: { directory: artifactDirectory, preview, animation, contactSheet, report },
      caveats: ["Snowstorm preview only; validate in Minecraft before shipping.", "Fixed-anchor composition assumes a stationary caster unless explicit layer transforms are supplied."]
    };
    await writeFile(report, `${JSON.stringify({ ...result, layerChecks: checks, sampleTimes: [...sampleFrames.values()] }, null, 2)}\n`);
    await Promise.all([...framePaths, ...samplePaths].map((file) => rm(file, { force: true })));
    completed = true;
    return result;
  } finally {
    if (browserDeadline) clearTimeout(browserDeadline);
    await Promise.allSettled([browser?.close(), host?.close()]);
    if (!completed) await rm(artifactDirectory, { recursive: true, force: true });
  }
}
