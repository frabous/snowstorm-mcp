import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { JsonObject, JsonValue, ParticleSummary, ProjectConfig, ValidationIssue, ValidationResult } from "./types.js";
import { summarizeParticle } from "./particle-store.js";
import { particleTexture, resolveTexturePath } from "./texture.js";
import { requireResolvedPathInside } from "./config.js";

function isObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function issuesFor(document: JsonObject, config: ProjectConfig, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const effect = isObject(document.particle_effect) ? document.particle_effect : undefined;
  const description = effect && isObject(effect.description) ? effect.description : undefined;
  const parameters = description && isObject(description.basic_render_parameters) ? description.basic_render_parameters : undefined;
  const components = effect && isObject(effect.components) ? effect.components : undefined;

  if (document.format_version !== "1.10.0") issues.push({ severity: "warning", code: "format-version", message: "Snowstorm and Blockbuster packages normally use format_version 1.10.0." });
  if (!effect) issues.push({ severity: "error", code: "particle-effect", message: "Missing particle_effect object.", path: "/particle_effect" });
  if (!description || typeof description.identifier !== "string" || !description.identifier) issues.push({ severity: "error", code: "identifier", message: "Missing particle identifier.", path: "/particle_effect/description/identifier" });
  if (!parameters || typeof parameters.material !== "string" || typeof parameters.texture !== "string") issues.push({ severity: "error", code: "render-parameters", message: "Missing material or texture.", path: "/particle_effect/description/basic_render_parameters" });
  if (!components) issues.push({ severity: "error", code: "components", message: "Missing particle components.", path: "/particle_effect/components" });
  if (!components) return issues;

  const names = Object.keys(components);
  if (!names.some((name) => name.startsWith("minecraft:emitter_rate_"))) issues.push({ severity: "error", code: "emitter-rate", message: "Missing emitter rate component." });
  if (!names.some((name) => name.startsWith("minecraft:emitter_lifetime_"))) issues.push({ severity: "error", code: "emitter-lifetime", message: "Missing emitter lifetime component." });
  if (!names.some((name) => name.startsWith("minecraft:emitter_shape_"))) issues.push({ severity: "warning", code: "emitter-shape", message: "No emitter shape; Snowstorm will use its fallback point." });
  if (!isObject(components["minecraft:particle_lifetime_expression"])) issues.push({ severity: "error", code: "particle-lifetime", message: "Missing minecraft:particle_lifetime_expression." });
  if (!isObject(components["minecraft:particle_appearance_billboard"])) issues.push({ severity: "error", code: "billboard", message: "Missing minecraft:particle_appearance_billboard." });
  if (isObject(components["minecraft:particle_motion_collision"]) && !isObject(components["minecraft:particle_motion_dynamic"])) {
    issues.push({ severity: "warning", code: "collision-motion", message: "Collision normally needs minecraft:particle_motion_dynamic." });
  }
  if (isObject(components["minecraft:emitter_lifetime_looping"])) {
    issues.push({ severity: "warning", code: "looping", message: "Looping emitter requires an explicit stop condition in the consuming spell." });
  }
  return issues;
}

export async function validateParticle(document: JsonObject, config: ProjectConfig, file: string): Promise<ValidationResult> {
  const issues = issuesFor(document, config, file);
  const summary = summarizeParticle(document, file);
  if (summary.texture?.includes(":")) {
    try {
      const textureFile = resolveTexturePath(particleTexture(document)!, config);
      await access(textureFile);
    } catch (error) {
      if (!issues.some((issue) => issue.code === "texture-missing")) issues.push({ severity: "warning", code: "texture-missing", message: String(error) });
    }
  }
  return { valid: !issues.some((issue) => issue.severity === "error"), issues, summary };
}

export async function validatePackage(config: ProjectConfig): Promise<{ valid: boolean; particleCount: number; selectorCount: number; issues: ValidationIssue[] }> {
  const issues: ValidationIssue[] = [];
  let selectors: unknown;
  try {
    selectors = JSON.parse(await readFile(config.selectorsFile, "utf8"));
  } catch (error) {
    return { valid: false, particleCount: 0, selectorCount: 0, issues: [{ severity: "error", code: "selectors-json", message: String(error) }] };
  }
  if (!Array.isArray(selectors)) return { valid: false, particleCount: 0, selectorCount: 0, issues: [{ severity: "error", code: "selectors-array", message: "selectors.json must contain an array." }] };
  const names = new Set<string>();
  for (const selector of selectors) {
    if (!isObject(selector) || typeof selector.name !== "string") issues.push({ severity: "error", code: "selector-name", message: "Every selector must have a name." });
    else if (names.has(selector.name)) issues.push({ severity: "error", code: "selector-duplicate", message: `Duplicate selector '${selector.name}'.` });
    else names.add(selector.name);
    if (isObject(selector) && typeof selector.morph === "string") {
      const scheme = /Scheme:\"([^\"]+)\"/.exec(selector.morph)?.[1];
      if (scheme) {
        try {
          const target = requireResolvedPathInside(config.particlesRoot, `${scheme}.json`);
          await access(target);
        } catch {
          issues.push({ severity: "error", code: "selector-scheme-missing", message: `Selector '${selector.name}' targets a missing or unsafe particle: ${scheme}.json` });
        }
      }
    }
  }
  return { valid: !issues.some((issue) => issue.severity === "error"), particleCount: 0, selectorCount: selectors.length, issues };
}
