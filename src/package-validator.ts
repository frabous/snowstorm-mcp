import { readFile } from "node:fs/promises";
import type { JsonObject, JsonValue, ProjectConfig, TimelineLayer, ValidationIssue } from "./types.js";
import { ParticleStore } from "./particle-store.js";
import { helperDetails, inspectSpellTimeline } from "./magicspells.js";
import { particleTiming, validateParticle } from "./validator.js";

interface Selector {
  name: string;
  scheme: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function push(issues: ValidationIssue[], severity: "error" | "warning", code: string, message: string, path?: string): void {
  issues.push({ severity, code, message, path });
}

function parseSelectors(value: unknown, issues: ValidationIssue[]): Selector[] {
  if (!Array.isArray(value)) {
    push(issues, "error", "selectors-array", "selectors.json must contain an array.");
    return [];
  }
  const output: Selector[] = [];
  const names = new Set<string>();
  const schemes = new Set<string>();
  value.forEach((entry, index) => {
    if (!isObject(entry)) {
      push(issues, "error", "selector-object", `Selector ${index} must be an object.`);
      return;
    }
    if (typeof entry.name !== "string" || !entry.name) {
      push(issues, "error", "selector-name", `Selector ${index} must have a non-empty name.`);
      return;
    }
    if (names.has(entry.name)) push(issues, "error", "selector-duplicate", `Duplicate selector '${entry.name}'.`);
    names.add(entry.name);
    if (entry.type !== "*") push(issues, "warning", "selector-type", `Selector '${entry.name}' normally uses type '*'.`);
    if (entry.enabled !== true) push(issues, "warning", "selector-disabled", `Selector '${entry.name}' is not enabled.`);
    if (typeof entry.morph !== "string") {
      push(issues, "error", "selector-morph", `Selector '${entry.name}' must have a morph string.`);
      return;
    }
    const scheme = /Scheme:\"([^\"]+)\"/.exec(entry.morph)?.[1];
    if (!scheme) {
      push(issues, "error", "selector-scheme", `Selector '${entry.name}' has no parseable Scheme.`);
      return;
    }
    if (schemes.has(scheme)) push(issues, "error", "selector-scheme-duplicate", `Particle Scheme '${scheme}' is targeted by more than one selector.`);
    schemes.add(scheme);
    output.push({ name: entry.name, scheme });
  });
  return output;
}

export async function validatePackage(
  config: ProjectConfig,
  store: ParticleStore,
  options: { mainSpell?: string; ticksPerSecond?: number; detail?: "summary" | "full" } = {}
) {
  const issues: ValidationIssue[] = [];
  let selectorsRaw: unknown;
  try {
    selectorsRaw = JSON.parse(await readFile(config.selectorsFile, "utf8")) as JsonValue;
  } catch (error) {
    push(issues, "error", "selectors-json", String(error));
    selectorsRaw = [];
  }
  const selectors = parseSelectors(selectorsRaw, issues);
  const selectorsByName = new Map(selectors.map((selector) => [selector.name, selector]));
  const selectorsByFile = new Map(selectors.map((selector) => [`${selector.scheme}.json`, selector]));
  const files = await store.listFiles();
  const particles = new Map<string, JsonObject>();
  const identifiers = new Map<string, string>();
  let particleWarnings = 0;
  for (const file of files) {
    try {
      const document = await store.read(file);
      particles.set(file, document);
      const validation = await validateParticle(document, config, file);
      for (const entry of validation.issues) {
        if (entry.severity === "warning") particleWarnings += 1;
        issues.push({ ...entry, message: `${file}: ${entry.message}` });
      }
      const identifier = validation.summary.identifier;
      if (identifier) {
        const previous = identifiers.get(identifier);
        if (previous) push(issues, "error", "identifier-duplicate", `Identifier '${identifier}' is shared by ${previous} and ${file}.`);
        else identifiers.set(identifier, file);
      }
    } catch (error) {
      push(issues, "error", "particle-json", `${file}: ${String(error)}`);
    }
  }
  for (const selector of selectors) {
    const file = `${selector.scheme}.json`;
    if (!particles.has(file)) push(issues, "error", "selector-scheme-missing", `Selector '${selector.name}' targets missing particle '${file}'.`);
  }
  for (const file of files) if (!selectorsByFile.has(file)) push(issues, "error", "particle-orphan", `Particle '${file}' has no selector.`);

  const spell = await inspectSpellTimeline(config, options.mainSpell, options.ticksPerSecond ?? 20);
  issues.push(...spell.issues);
  const helperUse = new Map<string, string>();
  const layers: TimelineLayer[] = [];
  for (const occurrence of spell.occurrences) {
    const helper = occurrence.helper;
    const definition = spell.spells[helper];
    if (!definition) {
      push(issues, "error", "helper-missing", `${spell.mainSpell} references missing helper '${helper}'.`);
      continue;
    }
    const details = helperDetails(definition);
    for (const message of details.issues) push(issues, "error", "helper-config", `${helper}: ${message}.`);
    const selector = details.selector ? selectorsByName.get(details.selector) : undefined;
    if (!selector && details.selector) push(issues, "error", "helper-selector", `${helper} targets missing selector '${details.selector}'.`);
    if (details.selector) {
      const previous = helperUse.get(details.selector);
      if (previous && previous !== helper) push(issues, "error", "selector-helper-duplicate", `Selector '${details.selector}' is used by ${previous} and ${helper}.`);
      else helperUse.set(details.selector, helper);
    }
    const file = selector ? `${selector.scheme}.json` : null;
    const document = file ? particles.get(file) : undefined;
    const timing = document ? particleTiming(document) : { emitterSeconds: null, particleSeconds: null };
    if (details.duration !== null && timing.emitterSeconds !== null && timing.particleSeconds !== null && details.duration < timing.emitterSeconds + timing.particleSeconds) {
      push(issues, "error", "helper-duration", `${helper} duration ${details.duration}s is shorter than emitter + particle lifetime ${timing.emitterSeconds + timing.particleSeconds}s.`);
    }
    const startTicks = occurrence.startTicks;
    layers.push({
      helper,
      startTicks,
      startSeconds: startTicks / spell.ticksPerSecond,
      selector: details.selector,
      scheme: selector?.scheme ?? null,
      file,
      anchor: details.anchor,
      helperDuration: details.duration,
      emitterSeconds: timing.emitterSeconds,
      particleSeconds: timing.particleSeconds,
      latestParticleEndSeconds: timing.emitterSeconds !== null && timing.particleSeconds !== null
        ? startTicks / spell.ticksPerSecond + timing.emitterSeconds + timing.particleSeconds
        : null,
      relativeOffset: details.relativeOffset
    });
  }
  for (const selector of selectors) if (!helperUse.has(selector.name)) push(issues, "error", "selector-helper-missing", `Selector '${selector.name}' has no scheduled helper.`);
  const errors = issues.filter((entry) => entry.severity === "error");
  const warnings = issues.filter((entry) => entry.severity === "warning");
  return {
    valid: errors.length === 0,
    mainSpell: spell.mainSpell,
    ticksPerSecond: spell.ticksPerSecond,
    counts: { particles: files.length, selectors: selectors.length, helpers: new Set(spell.occurrences.map((entry) => entry.helper)).size, scheduledLayers: layers.length },
    errors,
    warnings,
    warningCount: warnings.length,
    particleWarningCount: particleWarnings,
    layers: options.detail === "full" ? layers : undefined,
    timeline: { firstStartSeconds: layers.length ? Math.min(...layers.map((layer) => layer.startSeconds)) : null,
      latestParticleEndSeconds: layers.some((layer) => layer.latestParticleEndSeconds !== null)
        ? Math.max(...layers.flatMap((layer) => layer.latestParticleEndSeconds === null ? [] : [layer.latestParticleEndSeconds]))
        : null }
  };
}
