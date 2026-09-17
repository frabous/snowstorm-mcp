import path from "node:path";
import { requireResolvedPathInside } from "./config.js";
import type { JsonObject, ProjectConfig } from "./types.js";

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
