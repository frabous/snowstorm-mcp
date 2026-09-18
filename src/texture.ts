import path from "node:path";
import { open, stat } from "node:fs/promises";
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
