import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { requireResolvedPathInside } from "./config.js";
import type { JsonObject, ProjectConfig, TextureMetadata } from "./types.js";

export function resolveTexturePath(texture: string, config: ProjectConfig): string {
  const separator = texture.indexOf(":");
  if (separator < 1 || separator !== texture.lastIndexOf(":")) throw new Error(`Texture must use namespace:path syntax: ${texture}`);
  const namespace = texture.slice(0, separator);
  const texturePath = texture.slice(separator + 1).replace(/\.png$/i, "");
  if (!/^[a-zA-Z0-9_.-]+$/.test(namespace)) throw new Error(`Texture namespace contains unsupported characters: ${namespace}`);
  if (!texturePath || texturePath.includes("\\") || path.isAbsolute(texturePath)) throw new Error(`Texture path is unsafe: ${texture}`);
  const parts = texturePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Texture path is unsafe: ${texture}`);
  return requireResolvedPathInside(config.resourcePackRoot, path.join("assets", namespace, "textures", `${texturePath}.png`));
}

export function particleTexture(document: JsonObject): string | undefined {
  const effect = document.particle_effect as JsonObject | undefined;
  const description = effect?.description as JsonObject | undefined;
  const parameters = description?.basic_render_parameters as JsonObject | undefined;
  return typeof parameters?.texture === "string" ? parameters.texture : undefined;
}

export async function inspectTexture(texture: string, config: ProjectConfig): Promise<TextureMetadata> {
  const file = resolveTexturePath(texture, config);
  const details = await stat(file);
  if (details.size > 32 * 1024 * 1024) throw new Error(`Texture exceeds the 32 MiB validation limit: ${file}`);
  const handle = await open(file, "r");
  const png = Buffer.alloc(Math.min(details.size, 1024 * 1024));
  try {
    await handle.read(png, 0, png.length, 0);
  } finally {
    await handle.close();
  }
  const signature = "89504e470d0a1a0a";
  if (png.length < 33 || png.subarray(0, 8).toString("hex") !== signature || png.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error(`Texture is not a valid PNG: ${file}`);
  }
  const colorType = png[25]!;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 8_192 || height > 8_192 || width * height > 16_777_216) {
    throw new Error(`Texture dimensions exceed validation limits: ${width}x${height}`);
  }
  return {
    path: file,
    bytes: details.size,
    width,
    height,
    bitDepth: png[24]!,
    colorType,
    hasAlphaChannel: colorType === 4 || colorType === 6 || png.includes(Buffer.from("tRNS"))
  };
}

export interface TextureSheetEntry extends TextureMetadata {
  texture: string;
  dataUrl: string;
}

export interface TextureSheet {
  entries: TextureSheetEntry[];
  columns: number;
  sheet: string;
  report: string;
}

const escapeHtml = (value: string): string => value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);

/**
 * Renders the real PNGs on a checkerboard so alpha and contour are judgeable, next to
 * their declared dimensions. A hard straight contour here belongs to the artwork, not to
 * scene compositing, which is the distinction a scene render alone cannot make.
 */
export async function buildTextureSheet(config: ProjectConfig, textures: string[]): Promise<TextureSheet> {
  if (!textures.length || textures.length > 16) throw new Error("A texture sheet shows 1 to 16 textures.");
  const entries: TextureSheetEntry[] = [];
  for (const texture of textures) {
    const metadata = await inspectTexture(texture, config);
    const dataUrl = `data:image/png;base64,${(await readFile(metadata.path)).toString("base64")}`;
    entries.push({ ...metadata, texture, dataUrl });
  }
  const decodedBytes = entries.reduce((total, entry) => total + entry.width * entry.height * 4, 0);
  if (decodedBytes > 256 * 1024 * 1024) throw new Error("Texture sheet exceeds the aggregate 256 MiB decoded-texture budget.");
  const columns = Math.min(4, entries.length);
  const rows = Math.ceil(entries.length / columns);
  const tile = 256;
  const labelHeight = 46;
  const sheetWidth = columns * (tile + 12) + 12;
  const sheetHeight = rows * (tile + labelHeight + 12) + 12;
  const cards = entries.map((entry) => `
    <figure>
      <div class="frame" style="width:${tile}px;height:${tile}px"><img src="${entry.dataUrl}" width="${tile}" height="${tile}"></div>
      <figcaption>${escapeHtml(entry.texture)}<br>${entry.width}x${entry.height} &middot; ${entry.hasAlphaChannel ? "alpha" : "opaque"} &middot; ${(entry.bytes / 1024).toFixed(1)} KiB</figcaption>
    </figure>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{margin:0;background:#1b2228;font:12px/1.45 "Segoe UI",system-ui,sans-serif;color:#dfe6ec}
    main{display:grid;grid-template-columns:repeat(${columns},${tile + 12}px);gap:12px;padding:12px;width:${sheetWidth}px}
    figure{margin:0}
    .frame{background-color:#4a5560;background-image:linear-gradient(45deg,#39434d 25%,transparent 25%,transparent 75%,#39434d 75%),linear-gradient(45deg,#39434d 25%,transparent 25%,transparent 75%,#39434d 75%);background-size:16px 16px;background-position:0 0,8px 8px;border:1px solid #5c6873;display:flex;align-items:center;justify-content:center;overflow:hidden}
    .frame img{image-rendering:pixelated;max-width:100%;max-height:100%}
    figcaption{padding-top:5px;color:#a9b6c2;word-break:break-all}
  </style><main>${cards}</main>`;
  const artifactDirectory = path.join(config.artifactsRoot, "texture-sheets", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(artifactDirectory, { recursive: true });
  const sheet = path.join(artifactDirectory, "texture-sheet.png");
  const report = path.join(artifactDirectory, "report.json");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const timeout = setTimeout(() => { void browser?.close(); }, 60_000);
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: sheetWidth, height: sheetHeight }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => Promise.all(Array.from(document.images, (image) => image.decode().catch(() => undefined))));
    await page.screenshot({ path: sheet, fullPage: true });
  } finally {
    clearTimeout(timeout);
    await browser?.close();
  }
  await writeFile(report, `${JSON.stringify({
    entries: entries.map(({ dataUrl, ...rest }) => rest),
    columns,
    rows,
    tile,
    sheet,
    caveat: "A straight or hard-edged contour on a tile is the artwork's own alpha. It survives a scene render with depthWrite disabled, so it is not a compositing artefact."
  }, null, 2)}\n`);
  return { entries, columns, sheet, report };
}
