import type { JsonObject, JsonValue, ProjectConfig, TextureMetadata, ValidationIssue, ValidationResult } from "./types.js";
import { summarizeParticle } from "./particle-store.js";
import { inspectTexture, particleTexture } from "./texture.js";

const materials = new Set(["particles_alpha", "particles_blend", "particles_add", "particles_opaque"]);
const rateComponents = ["minecraft:emitter_rate_instant", "minecraft:emitter_rate_steady", "minecraft:emitter_rate_manual"];
const emitterLifetimeComponents = ["minecraft:emitter_lifetime_once", "minecraft:emitter_lifetime_looping", "minecraft:emitter_lifetime_expression"];
const motionComponents = ["minecraft:particle_motion_dynamic", "minecraft:particle_motion_parametric"];
const knownBlockbusterComponents = new Set([
  "blockbuster:particle_collision_appearance",
  "blockbuster:particle_collision_tinting",
  "blockbuster:particle_morph"
]);

export function isObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

export function finiteNumber(value: JsonValue | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function expressionOrNumber(value: JsonValue | undefined): boolean {
  return finiteNumber(value) !== null || (typeof value === "string" && value.trim().length > 0 && molangLooksBalanced(value));
}

function molangLooksBalanced(expression: string): boolean {
  if (/\b(?:NaN|Infinity)\b/.test(expression)) return false;
  const pairs: Record<string, string> = { ")": "(", "]": "[" };
  const stack: string[] = [];
  for (const char of expression) {
    if (char === "(" || char === "[") stack.push(char);
    else if (char === ")" || char === "]") {
      if (stack.pop() !== pairs[char]) return false;
    }
  }
  return stack.length === 0;
}

function issue(issues: ValidationIssue[], severity: "error" | "warning", code: string, message: string, path?: string): void {
  issues.push({ severity, code, message, path });
}

function checkVector(issues: ValidationIssue[], value: JsonValue | undefined, length: number, path: string, expressions = true): void {
  if (!Array.isArray(value) || value.length !== length) {
    issue(issues, "error", "vector", `${path} must contain ${length} values.`, path);
    return;
  }
  value.forEach((entry, index) => {
    if (finiteNumber(entry) !== null) return;
    if (expressions && typeof entry === "string" && entry.trim() && molangLooksBalanced(entry)) return;
    issue(issues, "error", "vector-value", `${path}[${index}] must be a finite number or balanced Molang expression.`, `${path}/${index}`);
  });
}

function numericVector(value: JsonValue | undefined, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  const output = value.map((entry) => finiteNumber(entry));
  return output.some((entry) => entry === null) ? null : output as number[];
}

function checkPositive(issues: ValidationIssue[], value: JsonValue | undefined, path: string, allowExpression = false): number | null {
  const numeric = finiteNumber(value);
  if (numeric !== null) {
    if (numeric <= 0) issue(issues, "error", "positive-number", `${path} must be greater than zero.`, path);
    return numeric;
  }
  if (allowExpression && typeof value === "string" && value.trim() && molangLooksBalanced(value)) return null;
  issue(issues, "error", "number", `${path} must be a finite positive number${allowExpression ? " or balanced Molang expression" : ""}.`, path);
  return null;
}

export function particleTiming(document: JsonObject): { emitterSeconds: number | null; particleSeconds: number | null } {
  const effect = isObject(document.particle_effect) ? document.particle_effect : undefined;
  const components = effect && isObject(effect.components) ? effect.components : undefined;
  if (!components) return { emitterSeconds: null, particleSeconds: null };
  const once = isObject(components["minecraft:emitter_lifetime_once"]) ? components["minecraft:emitter_lifetime_once"] : undefined;
  const looping = isObject(components["minecraft:emitter_lifetime_looping"]) ? components["minecraft:emitter_lifetime_looping"] : undefined;
  const lifetime = isObject(components["minecraft:particle_lifetime_expression"]) ? components["minecraft:particle_lifetime_expression"] : undefined;
  return {
    emitterSeconds: finiteNumber(once?.active_time) ?? finiteNumber(looping?.active_time),
    particleSeconds: finiteNumber(lifetime?.max_lifetime)
  };
}

function validateStructure(document: JsonObject, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const effect = isObject(document.particle_effect) ? document.particle_effect : undefined;
  const description = effect && isObject(effect.description) ? effect.description : undefined;
  const parameters = description && isObject(description.basic_render_parameters) ? description.basic_render_parameters : undefined;
  const components = effect && isObject(effect.components) ? effect.components : undefined;

  if (document.format_version !== "1.10.0") issue(issues, "error", "format-version", `${file} must use format_version 1.10.0.`, "/format_version");
  if (!effect) issue(issues, "error", "particle-effect", "Missing particle_effect object.", "/particle_effect");
  if (!description || typeof description.identifier !== "string" || !description.identifier.trim()) {
    issue(issues, "error", "identifier", "Missing particle identifier.", "/particle_effect/description/identifier");
  } else if (!/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(description.identifier)) {
    issue(issues, "warning", "identifier-pattern", `Identifier '${description.identifier}' is outside the usual Snowstorm pattern.`);
  }
  if (!parameters || typeof parameters.material !== "string" || typeof parameters.texture !== "string") {
    issue(issues, "error", "render-parameters", "Missing material or texture.", "/particle_effect/description/basic_render_parameters");
  } else if (!materials.has(parameters.material)) {
    issue(issues, "error", "material", `Unknown particle material '${parameters.material}'.`, "/particle_effect/description/basic_render_parameters/material");
  }
  if (!components) {
    issue(issues, "error", "components", "Missing particle components.", "/particle_effect/components");
    return issues;
  }

  const names = Object.keys(components);
  const rates = rateComponents.filter((name) => isObject(components[name]));
  const emitterLifetimes = emitterLifetimeComponents.filter((name) => isObject(components[name]));
  const motions = motionComponents.filter((name) => isObject(components[name]));
  if (rates.length !== 1) issue(issues, "error", "emitter-rate-mode", `Exactly one emitter rate mode is required; found ${rates.length}.`);
  if (emitterLifetimes.length !== 1) issue(issues, "error", "emitter-lifetime-mode", `Exactly one emitter lifetime mode is required; found ${emitterLifetimes.length}.`);
  if (motions.length > 1) issue(issues, "error", "motion-mode", `Dynamic and parametric motion cannot both be active.`);
  if (!names.some((name) => name.startsWith("minecraft:emitter_shape_"))) issue(issues, "warning", "emitter-shape", "No emitter shape; Snowstorm will use its fallback point.");

  const particleLifetime = isObject(components["minecraft:particle_lifetime_expression"]) ? components["minecraft:particle_lifetime_expression"] : undefined;
  if (!particleLifetime) issue(issues, "error", "particle-lifetime", "Missing minecraft:particle_lifetime_expression.");
  else checkPositive(issues, particleLifetime.max_lifetime, "/particle_effect/components/minecraft:particle_lifetime_expression/max_lifetime", true);

  for (const name of rates) {
    const rate = components[name] as JsonObject;
    for (const key of ["num_particles", "spawn_rate", "max_particles"]) {
      if (rate[key] !== undefined) checkPositive(issues, rate[key], `/particle_effect/components/${name}/${key}`, true);
    }
  }
  for (const name of emitterLifetimes) {
    const lifetime = components[name] as JsonObject;
    if (lifetime.active_time !== undefined) checkPositive(issues, lifetime.active_time, `/particle_effect/components/${name}/active_time`, true);
    if (lifetime.sleep_time !== undefined && finiteNumber(lifetime.sleep_time) !== null && finiteNumber(lifetime.sleep_time)! < 0) {
      issue(issues, "error", "sleep-time", `${name}.sleep_time cannot be negative.`);
    }
  }

  const billboard = isObject(components["minecraft:particle_appearance_billboard"]) ? components["minecraft:particle_appearance_billboard"] : undefined;
  if (!billboard) issue(issues, "error", "billboard", "Missing minecraft:particle_appearance_billboard.");
  else {
    checkVector(issues, billboard.size, 2, "/particle_effect/components/minecraft:particle_appearance_billboard/size");
    if (typeof billboard.facing_camera_mode !== "string" || !billboard.facing_camera_mode) issue(issues, "error", "facing", "Billboard facing_camera_mode must be a non-empty string.");
    const uv = isObject(billboard.uv) ? billboard.uv : undefined;
    if (billboard.uv !== undefined && !uv) issue(issues, "error", "uv", "Billboard uv must be an object.");
    if (uv) {
      if (uv.texture_width !== undefined) checkPositive(issues, uv.texture_width, "/particle_effect/components/minecraft:particle_appearance_billboard/uv/texture_width");
      if (uv.texture_height !== undefined) checkPositive(issues, uv.texture_height, "/particle_effect/components/minecraft:particle_appearance_billboard/uv/texture_height");
      if (uv.uv_size !== undefined) checkVector(issues, uv.uv_size, 2, "/particle_effect/components/minecraft:particle_appearance_billboard/uv/uv_size", false);
      const flipbook = isObject(uv.flipbook) ? uv.flipbook : undefined;
      if (uv.flipbook !== undefined && !flipbook) issue(issues, "error", "flipbook", "Flipbook must be an object.");
      if (flipbook) {
        for (const key of ["base_UV", "size_UV", "step_UV"]) if (flipbook[key] !== undefined) checkVector(issues, flipbook[key], 2, `/particle_effect/components/minecraft:particle_appearance_billboard/uv/flipbook/${key}`, false);
        checkPositive(issues, flipbook.frames_per_second, "/particle_effect/components/minecraft:particle_appearance_billboard/uv/flipbook/frames_per_second");
        const frames = checkPositive(issues, flipbook.max_frame, "/particle_effect/components/minecraft:particle_appearance_billboard/uv/flipbook/max_frame");
        if (frames !== null && !Number.isInteger(frames)) issue(issues, "error", "flipbook-frame-count", "Flipbook max_frame must be an integer.");
      }
    }
  }

  const collision = isObject(components["minecraft:particle_motion_collision"]);
  const localSpace = isObject(components["minecraft:emitter_local_space"]) ? components["minecraft:emitter_local_space"] : undefined;
  if (collision && !isObject(components["minecraft:particle_motion_dynamic"])) issue(issues, "warning", "collision-motion", "Collision normally needs dynamic motion.");
  if (collision && isObject(components["minecraft:particle_motion_parametric"])) issue(issues, "warning", "collision-parametric", "Parametric motion and collision are generally incompatible.");
  if (collision && localSpace?.position === true) issue(issues, "warning", "collision-local", "World collision may be ineffective with emitter-local position.");
  if (isObject(components["minecraft:emitter_lifetime_looping"])) issue(issues, "warning", "looping", "Looping emitter requires an explicit stop condition in the consuming spell.");
  for (const name of names.filter((entry) => entry.startsWith("blockbuster:"))) {
    if (!knownBlockbusterComponents.has(name)) issue(issues, "warning", "blockbuster-component", `Unknown Blockbuster component '${name}' is preserved.`);
  }
  return issues;
}

function validateTextureUv(document: JsonObject, metadata: TextureMetadata, issues: ValidationIssue[]): void {
  const effect = document.particle_effect as JsonObject;
  const components = effect.components as JsonObject;
  const billboard = components["minecraft:particle_appearance_billboard"] as JsonObject | undefined;
  const uv = billboard && isObject(billboard.uv) ? billboard.uv : undefined;
  if (!uv) return;
  const declaredWidth = finiteNumber(uv.texture_width);
  const declaredHeight = finiteNumber(uv.texture_height);
  if (declaredWidth !== null && declaredWidth !== metadata.width) issue(issues, "error", "texture-width", `Declared texture width ${declaredWidth} does not match PNG width ${metadata.width}.`);
  if (declaredHeight !== null && declaredHeight !== metadata.height) issue(issues, "error", "texture-height", `Declared texture height ${declaredHeight} does not match PNG height ${metadata.height}.`);
  const baseUv = numericVector(uv.uv, 2);
  const uvSize = numericVector(uv.uv_size, 2);
  if (baseUv && uvSize && (baseUv[0]! < 0 || baseUv[1]! < 0 || baseUv[0]! + uvSize[0]! > metadata.width || baseUv[1]! + uvSize[1]! > metadata.height)) {
    issue(issues, "error", "uv-bounds", `Billboard UV rectangle exceeds PNG bounds ${metadata.width}x${metadata.height}.`, "/particle_effect/components/minecraft:particle_appearance_billboard/uv");
  }
  const flipbook = isObject(uv.flipbook) ? uv.flipbook : undefined;
  if (!flipbook) return;
  const frames = finiteNumber(flipbook.max_frame);
  const base = numericVector(flipbook.base_UV ?? [0, 0], 2);
  const size = numericVector(flipbook.size_UV ?? uv.uv_size, 2);
  const step = numericVector(flipbook.step_UV, 2);
  if (frames === null || base === null || size === null || step === null) return;
  const last = frames - 1;
  const lastPosition = [base[0]! + last * step[0]!, base[1]! + last * step[1]!];
  const left = Math.min(base[0]!, lastPosition[0]!);
  const top = Math.min(base[1]!, lastPosition[1]!);
  const right = Math.max(base[0]!, lastPosition[0]!) + size[0]!;
  const bottom = Math.max(base[1]!, lastPosition[1]!) + size[1]!;
  if (left < 0 || top < 0 || right > metadata.width || bottom > metadata.height) issue(issues, "error", "flipbook-bounds", `Flipbook frames exceed PNG bounds ${metadata.width}x${metadata.height}.`);
}

export async function validateParticle(document: JsonObject, config: ProjectConfig, file: string): Promise<ValidationResult> {
  const issues = validateStructure(document, file);
  const summary = summarizeParticle(document, file);
  let texture: TextureMetadata | undefined;
  if (summary.texture) {
    try {
      texture = await inspectTexture(particleTexture(document)!, config);
      validateTextureUv(document, texture, issues);
    } catch (error) {
      issue(issues, "error", "texture", String(error));
    }
  }
  return { valid: !issues.some((entry) => entry.severity === "error"), issues, summary, texture };
}
