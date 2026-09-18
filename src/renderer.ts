import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";
import type { ParticleStore } from "./particle-store.js";
import type { JsonObject, ProjectConfig } from "./types.js";
import { startSnowstormHost } from "./snowstorm-host.js";
import { snowstormRoot } from "./config.js";
import { inspectTexture, particleTexture, resolveTexturePath } from "./texture.js";
import { enforceRenderBudget } from "./scene-renderer.js";

export interface RenderOptions {
  file: string;
  durationSeconds?: number;
  fps?: number;
  width?: number;
  height?: number;
  format?: "png" | "gif" | "mp4";
}

export interface RenderResult {
  artifactDirectory: string;
  previewPng: string;
  animation?: string;
  frameCount: number;
}

function projectRoot(config: ProjectConfig): string {
  return path.dirname(config.configPath);
}

async function resolveTextureDataUrl(document: Record<string, unknown>, config: ProjectConfig): Promise<string | undefined> {
  const texture = particleTexture(document as JsonObject);
  if (typeof texture !== "string") return undefined;
  await inspectTexture(texture, config);
  return `data:image/png;base64,${(await readFile(resolveTexturePath(texture, config))).toString("base64")}`;
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let error = "";
    const timeout = setTimeout(() => child.kill(), 120_000);
    child.stderr.on("data", (chunk: Buffer) => { error = `${error}${chunk.toString()}`.slice(-16_384); });
    child.once("error", (failure) => { clearTimeout(timeout); reject(failure); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${error.slice(-1000)}`));
    });
  });
}

export async function renderParticle(store: ParticleStore, config: ProjectConfig, options: RenderOptions): Promise<RenderResult> {
  const durationSeconds = options.durationSeconds ?? 1.5;
  const fps = options.fps ?? 12;
  const width = options.width ?? 960;
  const height = options.height ?? 540;
  if (durationSeconds <= 0 || durationSeconds > 30) throw new Error("durationSeconds must be between 0 and 30.");
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error("fps must be an integer between 1 and 30.");
  const source = await store.readRaw(options.file);
  enforceRenderBudget(source.document, options.file, durationSeconds);
  const frameCount = Math.max(1, Math.round(durationSeconds * fps));
  if (frameCount > 300) throw new Error("Render is limited to 300 frames to protect local disk and CPU.");
  const artifactDirectory = path.join(config.artifactsRoot, "renders", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(artifactDirectory, { recursive: true });
  let host: Awaited<ReturnType<typeof startSnowstormHost>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let browserDeadline: NodeJS.Timeout | undefined;
  let completed = false;
  try {
    host = await startSnowstormHost(snowstormRoot(projectRoot(config)), false, true);
    browser = await chromium.launch({ headless: true });
    browserDeadline = setTimeout(() => { void browser?.close(); }, 60_000);
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(`${host.url}/index.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => typeof (window as typeof window & { loadFileFromParentEffect?: unknown }).loadFileFromParentEffect === "function");
    await page.evaluate(({ raw, textureDataUrl }) => {
      (window as typeof window & { loadFileFromParentEffect(raw: string, texture?: string): void }).loadFileFromParentEffect(raw, textureDataUrl);
    }, { raw: source.raw, textureDataUrl: await resolveTextureDataUrl(source.document, config) });
    await page.waitForFunction(() => Boolean((window as typeof window & { __preview?: unknown }).__preview));
    await page.evaluate(({ width, height }) => {
      const root = window as typeof window & { __preview: any };
      root.__preview.renderer.setSize(width, height);
      const canvas = root.__preview.renderer.domElement as HTMLCanvasElement;
      document.body.appendChild(canvas);
      Object.assign(canvas.style, { display: "block", position: "fixed", left: "0", top: "0", width: `${width}px`, height: `${height}px`, zIndex: "2147483647" });
      root.__preview.camera.aspect = width / height;
      root.__preview.camera.updateProjectionMatrix();
    }, { width, height });
    const canvas = page.locator("#canvas");
    const framePaths: string[] = [];
    for (let frame = 0; frame < frameCount; frame += 1) {
      await page.evaluate(() => {
        const emitter = (window as typeof window & { Emitter: any }).Emitter;
        if (emitter.particles?.length > 10_000) throw new Error("Emitter exceeded the 10,000 live-particle runtime limit.");
      });
      const framePath = path.join(artifactDirectory, `frame-${String(frame).padStart(4, "0")}.png`);
      framePaths.push(framePath);
      await canvas.screenshot({ path: framePath });
      if (frame < frameCount - 1) await page.waitForTimeout(1000 / fps);
    }
    const previewPng = path.join(artifactDirectory, "preview.png");
    await canvas.screenshot({ path: previewPng });
    let animation: string | undefined;
    let palette: string | undefined;
    if (options.format === "gif") {
      animation = path.join(artifactDirectory, "preview.gif");
      palette = path.join(artifactDirectory, "palette.png");
      await runFfmpeg(["-framerate", String(fps), "-i", path.join(artifactDirectory, "frame-%04d.png"), "-vf", "palettegen", palette]);
      await runFfmpeg(["-framerate", String(fps), "-i", path.join(artifactDirectory, "frame-%04d.png"), "-i", palette, "-lavfi", "paletteuse", animation]);
    } else if (options.format === "mp4") {
      animation = path.join(artifactDirectory, "preview.mp4");
      await runFfmpeg(["-framerate", String(fps), "-i", path.join(artifactDirectory, "frame-%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", animation]);
    }
    await Promise.all([...framePaths, ...(palette ? [palette] : [])].map((file) => rm(file, { force: true })));
    completed = true;
    return { artifactDirectory, previewPng, animation, frameCount };
  } finally {
    if (browserDeadline) clearTimeout(browserDeadline);
    await Promise.allSettled([browser?.close(), host?.close()]);
    if (!completed) await rm(artifactDirectory, { recursive: true, force: true });
  }
}
