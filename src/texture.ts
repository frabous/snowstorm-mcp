import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { requireResolvedPathInside } from "./config.js";
import { artifactDirectoryPath } from "./artifact-path.js";
import { writeFileSafelyNoOverwrite } from "./safe-file.js";
import {
  BRIGHT_COVERAGE_THRESHOLD,
  createFlipbookAtlas,
  generateTexture,
  type FlipbookAtlas,
  type FlipbookAtlasOptions,
  type TextureGenerationOptions
} from "./texture-generator.js";
import type { JsonObject, ParticleSummary, ProjectConfig, TextureMetadata, TextureSource } from "./types.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_TEXTURE_PIXELS = 16_777_216;

interface ParsedTextureAddress {
  address: string;
  namespace: string;
  parts: string[];
}

interface TextureRoot {
  source: TextureSource;
  projectLayout: boolean;
}

interface TextureCandidate {
  address: string;
  path: string;
  source: TextureSource;
}

interface TextureMetrics {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  hasAlphaChannel: boolean;
  hasAlpha: boolean;
  nonZeroCoverage: number;
  brightCoverage: number;
  bytes: number;
}

const metadataCache = new Map<string, TextureMetrics>();
let metricsBrowserPromise: Promise<Browser> | undefined;
let metricsBrowser: Browser | undefined;
let metricsBrowserIdle: ReturnType<typeof setTimeout> | undefined;
let activeMetricReads = 0;

function normalizePathKey(value: string): string {
  return path.resolve(value).replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase();
}

function normalizeTextureKey(value: string): string {
  return value.replaceAll("\\", "/").replace(/\.png$/i, "").toLowerCase();
}

function parseTextureAddress(texture: string): ParsedTextureAddress {
  const separator = texture.indexOf(":");
  if (separator < 1 || separator !== texture.lastIndexOf(":")) throw new Error(`Texture must use namespace:path syntax: ${texture}`);
  const namespace = texture.slice(0, separator);
  const texturePath = texture.slice(separator + 1).replace(/\.png$/i, "");
  if (!/^[a-zA-Z0-9_.-]+$/.test(namespace)) throw new Error(`Texture namespace contains unsupported characters: ${namespace}`);
  if (!texturePath || texturePath.includes("\\") || path.isAbsolute(texturePath)) throw new Error(`Texture path is unsafe: ${texture}`);
  const parts = texturePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Texture path is unsafe: ${texture}`);
  return { address: `${namespace}:${parts.join("/")}`, namespace, parts };
}

function textureRoots(config: ProjectConfig): TextureRoot[] {
  const roots: TextureRoot[] = [{
    source: { kind: "project", root: path.resolve(config.resourcePackRoot) },
    projectLayout: true
  }];
  for (const [bankIndex, root] of (config.sharedTextureBanks ?? []).entries()) {
    roots.push({ source: { kind: "shared_bank", root: path.resolve(root), bankIndex }, projectLayout: false });
  }
  const seen = new Set<string>();
  return roots.filter(({ source, projectLayout }) => {
    const key = `${normalizePathKey(source.root)}\0${projectLayout ? "project" : "bank"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function relativeTexturePath(address: ParsedTextureAddress, projectLayout: boolean): string {
  return projectLayout
    ? path.join("assets", address.namespace, "textures", ...address.parts) + ".png"
    : path.join(address.namespace, ...address.parts) + ".png";
}

function candidatePath(root: TextureRoot, address: ParsedTextureAddress): string {
  return requireResolvedPathInside(root.source.root, relativeTexturePath(address, root.projectLayout));
}

function sourceForBank(config: ProjectConfig, selection: number | string): TextureSource {
  const banks = config.sharedTextureBanks ?? [];
  if (typeof selection === "number") {
    if (!Number.isInteger(selection) || selection < 0 || selection >= banks.length) {
      throw new Error(`bank must be an index from 0 to ${Math.max(0, banks.length - 1)} for the configured sharedTextureBanks.`);
    }
    return { kind: "shared_bank", root: path.resolve(banks[selection]!), bankIndex: selection };
  }
  const requested = normalizePathKey(selection);
  const bankIndex = banks.findIndex((bank) => normalizePathKey(bank) === requested);
  if (bankIndex < 0) throw new Error("bank must exactly match one configured sharedTextureBanks root or use its zero-based index.");
  return { kind: "shared_bank", root: path.resolve(banks[bankIndex]!), bankIndex };
}

function outputRoot(config: ProjectConfig, bank?: number | string): TextureRoot {
  if (bank === undefined) return { source: { kind: "project", root: path.resolve(config.resourcePackRoot) }, projectLayout: true };
  return { source: sourceForBank(config, bank), projectLayout: false };
}

async function decodePngMetrics(bytes: Buffer): Promise<{ hasAlpha: boolean; nonZeroCoverage: number; brightCoverage: number }> {
  if (metricsBrowserIdle) clearTimeout(metricsBrowserIdle);
  activeMetricReads += 1;
  let page: Awaited<ReturnType<Browser["newPage"]>> | undefined;
  try {
    metricsBrowserPromise ??= chromium.launch({ headless: true }).then((browser) => {
      metricsBrowser = browser;
      return browser;
    }).catch((error: unknown) => {
      metricsBrowserPromise = undefined;
      throw error;
    });
    const browser = await metricsBrowserPromise;
    page = await browser.newPage();
    return await page.evaluate(async ({ dataUrl, brightThreshold }) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Chromium could not create a PNG measurement canvas.");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hasAlpha = false;
      let nonZeroPixels = 0;
      let brightPixels = 0;
      const pixelCount = canvas.width * canvas.height;
      for (let index = 0; index < pixels.length; index += 4) {
        const alpha = pixels[index + 3]! / 255;
        if (alpha < 1) hasAlpha = true;
        if (alpha > 0) nonZeroPixels += 1;
        const luminance = (0.2126 * pixels[index]! + 0.7152 * pixels[index + 1]! + 0.0722 * pixels[index + 2]!) / 255;
        if (alpha * luminance >= brightThreshold) brightPixels += 1;
      }
      return {
        hasAlpha,
        nonZeroCoverage: nonZeroPixels / pixelCount,
        brightCoverage: brightPixels / pixelCount
      };
    }, {
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      brightThreshold: BRIGHT_COVERAGE_THRESHOLD
    });
  } catch (error) {
    throw new Error(`Unable to decode PNG pixels with Chromium: ${String(error)}`);
  } finally {
    await page?.close();
    activeMetricReads -= 1;
    if (activeMetricReads === 0) {
      metricsBrowserIdle = setTimeout(() => {
        if (activeMetricReads !== 0) return;
        const browser = metricsBrowser;
        metricsBrowser = undefined;
        metricsBrowserPromise = undefined;
        if (browser) void browser.close();
      }, 500);
      metricsBrowserIdle.unref();
    }
  }
}

async function inspectPngBytes(bytes: Buffer, label: string): Promise<TextureMetrics> {
  if (bytes.length > MAX_PNG_BYTES) throw new Error(`Texture exceeds the 32 MiB validation limit: ${label}`);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`Texture is not a valid PNG: ${label}`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 8_192 || height > 8_192 || width * height > MAX_TEXTURE_PIXELS) {
    throw new Error(`Texture dimensions exceed validation limits: ${width}x${height}`);
  }
  let hasTransparencyChunk = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new Error(`Texture is not a valid PNG: ${label}`);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "tRNS") hasTransparencyChunk = true;
    offset += length + 12;
    if (bytes.toString("ascii", offset - 8, offset - 4) === "IEND") break;
  }
  const decoded = await decodePngMetrics(bytes);
  const colorType = bytes[25]!;
  return {
    bytes: bytes.length,
    width,
    height,
    bitDepth: bytes[24]!,
    colorType,
    hasAlphaChannel: colorType === 4 || colorType === 6 || hasTransparencyChunk,
    ...decoded
  };
}

async function inspectTextureFile(
  file: string,
  source: TextureSource,
  shadowedSources: TextureSource[]
): Promise<TextureMetadata> {
  const details = await stat(file);
  if (!details.isFile()) throw new Error(`Texture is not a file: ${file}`);
  if (details.size > MAX_PNG_BYTES) throw new Error(`Texture exceeds the 32 MiB validation limit: ${file}`);
  const cachePath = normalizePathKey(file);
  const cacheKey = `${cachePath}\0${details.mtimeMs}\0${details.ctimeMs}\0${details.size}`;
  let metrics = metadataCache.get(cacheKey);
  if (!metrics) {
    const bytes = await readFile(file);
    if (bytes.length > MAX_PNG_BYTES) throw new Error(`Texture exceeds the 32 MiB validation limit: ${file}`);
    const decoded = await inspectPngBytes(bytes, file);
    metrics = { ...decoded, bytes: details.size };
    for (const key of metadataCache.keys()) if (key.startsWith(`${cachePath}\0`)) metadataCache.delete(key);
    metadataCache.set(cacheKey, metrics);
  }
  return { ...metrics, path: file, source, shadowedSources };
}

function existingTextureCandidates(texture: string, config: ProjectConfig): TextureCandidate[] {
  const address = parseTextureAddress(texture);
  const candidates: TextureCandidate[] = [];
  for (const root of textureRoots(config)) {
    if (!existsSync(root.source.root)) continue;
    const file = candidatePath(root, address);
    if (!existsSync(file)) continue;
    const secureFile = requireResolvedPathInside(root.source.root, relativeTexturePath(address, root.projectLayout));
    try {
      if (statSync(secureFile).isFile()) candidates.push({ address: address.address, path: secureFile, source: root.source });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return candidates;
}

export interface ResolvedTexture {
  texture: string;
  path: string;
  source: TextureSource;
  shadowedSources: TextureSource[];
}

export function resolveTexture(texture: string, config: ProjectConfig): ResolvedTexture {
  const candidates = existingTextureCandidates(texture, config);
  const winner = candidates[0];
  if (!winner) throw new Error(`Texture was not found in the project resource pack or configured shared banks: ${texture}`);
  return {
    texture: winner.address,
    path: winner.path,
    source: winner.source,
    shadowedSources: candidates.slice(1).map((candidate) => candidate.source)
  };
}

export function resolveTexturePath(texture: string, config: ProjectConfig): string {
  const parsed = parseTextureAddress(texture);
  const found = existingTextureCandidates(parsed.address, config)[0];
  if (found) return found.path;
  return candidatePath(textureRoots(config)[0]!, parsed);
}

export function particleTexture(document: JsonObject): string | undefined {
  const effect = document.particle_effect as JsonObject | undefined;
  const description = effect?.description as JsonObject | undefined;
  const parameters = description?.basic_render_parameters as JsonObject | undefined;
  return typeof parameters?.texture === "string" ? parameters.texture : undefined;
}

export async function inspectTexture(texture: string, config: ProjectConfig): Promise<TextureMetadata> {
  const resolution = resolveTexture(texture, config);
  return inspectTextureFile(resolution.path, resolution.source, resolution.shadowedSources);
}

export interface TextureCatalogFilters {
  nameContains?: string;
  minCoverage?: number;
  hasAlpha?: boolean;
  width?: number;
  height?: number;
  usedBy?: string;
  limit?: number;
}

export interface TextureCatalogEntry extends TextureMetadata {
  texture: string;
  usedBy: Array<{ file: string; identifier: string | null }>;
}

async function catalogRoot(root: TextureRoot): Promise<TextureCandidate[]> {
  if (!existsSync(root.source.root)) return [];
  const namespaceRoot = root.projectLayout ? path.join(root.source.root, "assets") : root.source.root;
  let namespaces;
  try {
    namespaces = await readdir(namespaceRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const output: TextureCandidate[] = [];
  for (const namespaceEntry of namespaces) {
    if (!namespaceEntry.isDirectory() || !/^[a-zA-Z0-9_.-]+$/.test(namespaceEntry.name)) continue;
    const textureRoot = root.projectLayout
      ? path.join(namespaceRoot, namespaceEntry.name, "textures")
      : path.join(namespaceRoot, namespaceEntry.name);
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
          const relative = path.relative(textureRoot, file).replaceAll(path.sep, "/").replace(/\.png$/i, "");
          const address = `${namespaceEntry.name}:${relative}`;
          try {
            const parsed = parseTextureAddress(address);
            const secureFile = requireResolvedPathInside(root.source.root, path.relative(root.source.root, file));
            output.push({ address: parsed.address, path: secureFile, source: root.source });
          } catch (error) {
            if (String(error).includes("unsafe")) continue;
            throw error;
          }
        }
      }
    };
    await walk(textureRoot);
  }
  return output.sort((left, right) => left.address.localeCompare(right.address));
}

function particleTextureKey(texture: string): string | undefined {
  try {
    return normalizeTextureKey(parseTextureAddress(texture).address);
  } catch {
    return undefined;
  }
}

export async function listTextures(
  config: ProjectConfig,
  particles: ParticleSummary[],
  filters: TextureCatalogFilters = {}
): Promise<TextureCatalogEntry[]> {
  const candidates = (await Promise.all(textureRoots(config).map(catalogRoot))).flat();
  const grouped = new Map<string, { winner: TextureCandidate; shadowed: TextureSource[] }>();
  for (const candidate of candidates) {
    const key = normalizeTextureKey(candidate.address);
    const existing = grouped.get(key);
    if (existing) existing.shadowed.push(candidate.source);
    else grouped.set(key, { winner: candidate, shadowed: [] });
  }
  const usedByTexture = new Map<string, Array<{ file: string; identifier: string | null }>>();
  for (const particle of particles) {
    if (!particle.texture) continue;
    const key = particleTextureKey(particle.texture);
    if (!key) continue;
    const uses = usedByTexture.get(key) ?? [];
    uses.push({ file: particle.file, identifier: particle.identifier });
    usedByTexture.set(key, uses);
  }

  const nameNeedle = filters.nameContains?.toLowerCase();
  const usedByNeedle = filters.usedBy?.toLowerCase();
  const output: TextureCatalogEntry[] = [];
  for (const { winner, shadowed } of grouped.values()) {
    const name = winner.address.toLowerCase();
    if (nameNeedle && !name.includes(nameNeedle) && !path.basename(name).includes(nameNeedle)) continue;
    const usedBy = usedByTexture.get(normalizeTextureKey(winner.address)) ?? [];
    if (usedByNeedle && !usedBy.some((use) => use.file.toLowerCase().includes(usedByNeedle) || use.identifier?.toLowerCase().includes(usedByNeedle))) continue;
    const metadata = await inspectTextureFile(winner.path, winner.source, shadowed);
    if (filters.minCoverage !== undefined && metadata.nonZeroCoverage < filters.minCoverage) continue;
    if (filters.hasAlpha !== undefined && metadata.hasAlpha !== filters.hasAlpha) continue;
    if (filters.width !== undefined && metadata.width !== filters.width) continue;
    if (filters.height !== undefined && metadata.height !== filters.height) continue;
    output.push({ texture: winner.address, ...metadata, usedBy });
  }
  return output.sort((left, right) => left.texture.localeCompare(right.texture)).slice(0, filters.limit ?? 60);
}

export interface GenerateTextureAssetOptions extends TextureGenerationOptions {
  texture: string;
  bank?: number | string;
}

export interface TextureAssetResult {
  texture: string;
  path: string;
  digest: string;
  bytes: number;
  source: TextureSource;
  metrics: Pick<TextureMetadata, "width" | "height" | "hasAlpha" | "nonZeroCoverage" | "brightCoverage">;
  resolution: ResolvedTexture;
  note: string;
}

async function persistTextureAsset(
  config: ProjectConfig,
  textureValue: string,
  bytes: Buffer,
  bank?: number | string,
  measured?: Pick<TextureMetadata, "width" | "height" | "hasAlpha" | "nonZeroCoverage" | "brightCoverage">,
  beforeWrite?: () => void
): Promise<TextureAssetResult> {
  const address = parseTextureAddress(textureValue);
  const root = outputRoot(config, bank);
  await mkdir(root.source.root, { recursive: true });
  const target = candidatePath(root, address);
  const metrics = measured ?? await inspectPngBytes(bytes, target);
  const write = await writeFileSafelyNoOverwrite(target, bytes, beforeWrite);
  const resolution = resolveTexture(address.address, config);
  return {
    texture: address.address,
    path: target,
    digest: write.digest,
    bytes: bytes.length,
    source: root.source,
    metrics: {
      width: metrics.width,
      height: metrics.height,
      hasAlpha: metrics.hasAlpha,
      nonZeroCoverage: metrics.nonZeroCoverage,
      brightCoverage: metrics.brightCoverage
    },
    resolution,
    note: "This is a generated/imported PNG asset with decoded pixel metrics, not proof of Minecraft playback."
  };
}

export async function generateTextureAsset(
  config: ProjectConfig,
  options: GenerateTextureAssetOptions,
  beforeWrite?: () => void
): Promise<TextureAssetResult> {
  const address = parseTextureAddress(options.texture);
  const generated = await generateTexture(options);
  return persistTextureAsset(config, address.address, generated.bytes, options.bank, {
    width: generated.width,
    height: generated.height,
    hasAlpha: generated.hasAlpha,
    nonZeroCoverage: generated.alphaCoverage,
    brightCoverage: generated.brightCoverage
  }, beforeWrite);
}

export interface ImportTextureAssetOptions {
  sourcePath: string;
  bank: number | string;
  name?: string;
}

export async function importTextureAsset(
  config: ProjectConfig,
  options: ImportTextureAssetOptions,
  beforeWrite?: () => void
): Promise<TextureAssetResult> {
  if (options.bank === undefined) throw new Error("Choose a configured shared texture bank by zero-based index or exact root path.");
  const sourceDetails = await stat(options.sourcePath);
  if (!sourceDetails.isFile()) throw new Error(`Texture import source is not a file: ${options.sourcePath}`);
  if (sourceDetails.size > MAX_PNG_BYTES) throw new Error(`Texture exceeds the 32 MiB validation limit: ${options.sourcePath}`);
  const bytes = await readFile(options.sourcePath);
  const metrics = await inspectPngBytes(bytes, options.sourcePath);
  const basename = path.basename(options.sourcePath).replace(/\.png$/i, "");
  const safeName = basename.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^\.+|\.+$/g, "") || "texture";
  const address = parseTextureAddress(options.name ?? `imported:${safeName}`);
  return persistTextureAsset(config, address.address, bytes, options.bank, {
    width: metrics.width,
    height: metrics.height,
    hasAlpha: metrics.hasAlpha,
    nonZeroCoverage: metrics.nonZeroCoverage,
    brightCoverage: metrics.brightCoverage
  }, beforeWrite);
}

export async function textureFlipbookAtlas(
  texture: string,
  config: ProjectConfig,
  options: FlipbookAtlasOptions
): Promise<{ texture: string; path: string; source: TextureSource; shadowedSources: TextureSource[]; atlas: FlipbookAtlas }> {
  const metadata = await inspectTexture(texture, config);
  return {
    texture: parseTextureAddress(texture).address,
    path: metadata.path,
    source: metadata.source,
    shadowedSources: metadata.shadowedSources,
    atlas: createFlipbookAtlas(metadata.width, metadata.height, options)
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
  const artifactDirectory = artifactDirectoryPath(config.artifactsRoot, "texture-sheets");
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
