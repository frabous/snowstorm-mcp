import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";
import type { ParticleStore } from "./particle-store.js";
import type { JsonObject, ProjectConfig } from "./types.js";
import { startSnowstormHost } from "./snowstorm-host.js";
import { snowstormRoot } from "./config.js";
import { particleTexture, resolveTexturePath } from "./texture.js";

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
  if (typeof texture !== "string" || !texture.includes(":")) return undefined;
  try {
    return `data:image/png;base64,${(await readFile(resolveTexturePath(texture, config))).toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${error.slice(-1000)}`)));
  });
}

export async function renderParticle(store: ParticleStore, config: ProjectConfig, options: RenderOptions): Promise<RenderResult> {
  const durationSeconds = options.durationSeconds ?? 1.5;
  const fps = options.fps ?? 12;
  const width = options.width ?? 960;
  const height = options.height ?? 540;
  if (durationSeconds <= 0 || durationSeconds > 15) throw new Error("durationSeconds must be between 0 and 15.");
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error("fps must be an integer between 1 and 30.");
  const source = await store.readRaw(options.file);
  const frameCount = Math.max(1, Math.round(durationSeconds * fps));
  if (frameCount > 180) throw new Error("Render is limited to 180 frames to protect local disk and CPU.");
  const artifactDirectory = path.join(config.artifactsRoot, "renders", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(artifactDirectory, { recursive: true });
  const host = await startSnowstormHost(snowstormRoot(projectRoot(config)));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(`${host.url}/index.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => typeof (window as typeof window & { loadFileFromParentEffect?: unknown }).loadFileFromParentEffect === "function");
    await page.evaluate(({ raw, textureDataUrl }) => {
      (window as typeof window & { loadFileFromParentEffect(raw: string, texture?: string): void }).loadFileFromParentEffect(raw, textureDataUrl);
    }, { raw: source.raw, textureDataUrl: await resolveTextureDataUrl(source.document, config) });
    await page.locator("#canvas").waitFor();
    const canvas = page.locator("#canvas");
    for (let frame = 0; frame < frameCount; frame += 1) {
      await canvas.screenshot({ path: path.join(artifactDirectory, `frame-${String(frame).padStart(4, "0")}.png`) });
      if (frame < frameCount - 1) await page.waitForTimeout(1000 / fps);
    }
    const previewPng = path.join(artifactDirectory, "preview.png");
    await canvas.screenshot({ path: previewPng });
    let animation: string | undefined;
    if (options.format === "gif") {
      animation = path.join(artifactDirectory, "preview.gif");
      const palette = path.join(artifactDirectory, "palette.png");
      await runFfmpeg(["-framerate", String(fps), "-i", path.join(artifactDirectory, "frame-%04d.png"), "-vf", "palettegen", palette]);
      await runFfmpeg(["-framerate", String(fps), "-i", path.join(artifactDirectory, "frame-%04d.png"), "-i", palette, "-lavfi", "paletteuse", animation]);
    } else if (options.format === "mp4") {
      animation = path.join(artifactDirectory, "preview.mp4");
      await runFfmpeg(["-framerate", String(fps), "-i", path.join(artifactDirectory, "frame-%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", animation]);
    }
    return { artifactDirectory, previewPng, animation, frameCount };
  } finally {
    await Promise.allSettled([browser?.close(), host.close()]);
  }
}
