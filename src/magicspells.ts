import { readFile } from "node:fs/promises";
import { isSeq, parseDocument, type Document, type YAMLSeq } from "yaml";
import type { ProjectConfig, TimelineLayer, ValidationIssue } from "./types.js";
import { readTextWithDigest, writeTextSafely } from "./safe-file.js";

type Spell = Record<string, unknown>;
type SpellMap = Record<string, Spell>;

export interface SpellTimeline {
  mainSpell: string;
  ticksPerSecond: number;
  digest: string;
  starts: Record<string, number>;
  order: string[];
  occurrences: Array<{ id: string; helper: string; invocation: string; startTicks: number; sequenceIndex: number }>;
  endTicks: number;
  issues: ValidationIssue[];
  spells: SpellMap;
}

const maximumTimelineSeconds = 21_600;

function push(issues: ValidationIssue[], severity: "error" | "warning", code: string, message: string): void {
  issues.push({ severity, code, message });
}

function parseDelay(step: string): number | null {
  const match = /^DELAY\s+(\d+)$/.exec(step.trim());
  return match ? Number(match[1]) : null;
}

function invocationName(step: string): string {
  const trimmed = step.trim();
  const opening = trimmed.indexOf("(");
  return opening > 0 && trimmed.endsWith(")") ? trimmed.slice(0, opening).trim() : trimmed;
}

function asSpellMap(value: unknown): SpellMap {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("MagicSpells YAML root must be a mapping.");
  return value as SpellMap;
}

function parseYaml(raw: string): { document: Document.Parsed; spells: SpellMap; issues: ValidationIssue[] } {
  const document = parseDocument(raw, { uniqueKeys: true, prettyErrors: true, strict: true });
  const issues: ValidationIssue[] = [];
  for (const error of document.errors) push(issues, "error", "spell-yaml", error.message);
  for (const warning of document.warnings) push(issues, "warning", "spell-yaml-warning", warning.message);
  if (document.errors.length) return { document, spells: {}, issues };
  try {
    return { document, spells: asSpellMap(document.toJS({ maxAliasCount: 1000 })), issues };
  } catch (error) {
    push(issues, "error", "spell-yaml-root", String(error));
    return { document, spells: {}, issues };
  }
}

function inferMainSpell(spells: SpellMap): string | null {
  const candidates = Object.entries(spells).filter(([, spell]) => spell?.["spell-class"] === ".MultiSpell" && spell["helper-spell"] !== true);
  return candidates.length === 1 ? candidates[0]![0] : null;
}

export async function inspectSpellTimeline(config: ProjectConfig, mainSpell?: string, ticksPerSecond = 20): Promise<SpellTimeline> {
  const source = await readTextWithDigest(config.spellFile);
  const parsed = parseYaml(source.raw);
  const selected = mainSpell ?? inferMainSpell(parsed.spells);
  if (!selected) push(parsed.issues, "error", "main-spell", "Specify mainSpell because it could not be inferred uniquely.");
  const starts: Record<string, number> = {};
  const order: string[] = [];
  const occurrences: SpellTimeline["occurrences"] = [];
  let endTicks = 0;
  const maximumTicks = ticksPerSecond * maximumTimelineSeconds;
  if (selected) {
    const parent = parsed.spells[selected];
    if (!parent) push(parsed.issues, "error", "main-spell-missing", `MagicSpells entry '${selected}' does not exist.`);
    else if (parent["spell-class"] !== ".MultiSpell") push(parsed.issues, "error", "main-spell-class", `${selected} must use .MultiSpell because it owns DELAY entries.`);
    else if (!Array.isArray(parent.spells)) push(parsed.issues, "error", "main-spell-sequence", `${selected}.spells must be a sequence.`);
    else {
      let tick = 0;
      for (const [sequenceIndex, rawStep] of parent.spells.entries()) {
        if (typeof rawStep !== "string") {
          push(parsed.issues, "error", "spell-step", `${selected}.spells entries must be strings.`);
          continue;
        }
        const delay = parseDelay(rawStep);
        if (delay !== null) {
          if (!Number.isSafeInteger(delay) || delay > maximumTicks) {
            push(parsed.issues, "error", "delay-range", `${selected}.spells contains an unsafe or excessive delay '${rawStep}'.`);
            continue;
          }
          tick += delay;
          if (!Number.isSafeInteger(tick) || tick > maximumTicks) push(parsed.issues, "error", "timeline-range", `${selected} exceeds the maximum supported timeline length.`);
          continue;
        }
        const helper = invocationName(rawStep);
        if (!parsed.spells[helper]) {
          push(parsed.issues, "error", "helper-missing", `${selected} references missing helper '${helper}'.`);
          continue;
        }
        const id = `${sequenceIndex}:${helper}`;
        occurrences.push({ id, helper, invocation: rawStep, startTicks: tick, sequenceIndex });
        if (starts[helper] === undefined) starts[helper] = tick;
        order.push(helper);
      }
      endTicks = tick;
    }
  }
  for (const [name, spell] of Object.entries(parsed.spells)) {
    if (spell?.["spell-class"] === ".TargetedMultiSpell" && Array.isArray(spell.spells)) {
      for (const step of spell.spells) {
        if (typeof step === "string" && parseDelay(step) !== null) push(parsed.issues, "error", "targeted-delay", `${name} contains DELAY, which .TargetedMultiSpell does not support.`);
      }
    }
  }
  return { mainSpell: selected ?? "", ticksPerSecond, digest: source.digest, starts, order, occurrences, endTicks, issues: parsed.issues, spells: parsed.spells };
}

function nestedCustomNames(
  value: unknown,
  state = { output: [] as string[], visited: new WeakSet<object>(), nodes: 0, limited: false },
  depth = 0
): typeof state {
  if (depth > 64 || state.nodes > 10_000) {
    state.limited = true;
    return state;
  }
  if (value && typeof value === "object") {
    if (state.visited.has(value)) {
      state.limited = true;
      return state;
    }
    state.visited.add(value);
    state.nodes += 1;
  }
  if (Array.isArray(value)) value.forEach((entry) => nestedCustomNames(entry, state, depth + 1));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "custom-name" && typeof entry === "string") state.output.push(entry);
      else nestedCustomNames(entry, state, depth + 1);
    }
  }
  return state;
}

export function helperDetails(spell: Spell): {
  selector: string | null;
  anchor: TimelineLayer["anchor"];
  duration: number | null;
  relativeOffset: string | null;
  issues: string[];
} {
  const traversal = nestedCustomNames(spell);
  const names = [...new Set(traversal.output)];
  const spellClass = spell["spell-class"];
  const anchor = spellClass === ".buff.ArmorStandSpell"
    ? "caster_attached"
    : spellClass === ".instant.ParticleProjectileSpell"
      ? "fixed_at_helper_launch"
      : "unknown";
  const durationKey = anchor === "caster_attached" ? "duration" : anchor === "fixed_at_helper_launch" ? "max-duration" : "";
  const duration = durationKey && typeof spell[durationKey] === "number" && Number.isFinite(spell[durationKey]) ? spell[durationKey] as number : null;
  const issues: string[] = [];
  if (traversal.limited) issues.push("helper structure is cyclic or exceeds traversal limits");
  if (names.length !== 1) issues.push(`expected exactly one custom-name, found ${names.length}`);
  if (anchor === "caster_attached") {
    if (spell["cancel-on-logout"] !== true) issues.push("attached helper must set cancel-on-logout: true");
    if (spell["cancel-on-teleport"] !== true) issues.push("attached helper must set cancel-on-teleport: true");
  } else if (anchor === "fixed_at_helper_launch") {
    if (spell["projectile-velocity"] !== 0) issues.push("fixed helper must set projectile-velocity: 0");
    if (spell["change-pitch"] !== false) issues.push("fixed helper must set change-pitch: false");
  }
  return {
    selector: names[0] ?? null,
    anchor,
    duration,
    relativeOffset: typeof spell["relative-offset"] === "string" ? spell["relative-offset"] : null,
    issues
  };
}

export async function retimeSpell(
  config: ProjectConfig,
  options: {
    mainSpell: string;
    expectedDigest: string;
    starts: Record<string, number>;
    unit: "ticks" | "seconds";
    ticksPerSecond?: number;
    dryRun?: boolean;
  }
) {
  const ticksPerSecond = options.ticksPerSecond ?? 20;
  const source = await readTextWithDigest(config.spellFile);
  if (source.digest !== options.expectedDigest) throw new Error("MagicSpells file changed since it was inspected.");
  const parsed = parseYaml(source.raw);
  if (parsed.issues.some((entry) => entry.severity === "error")) return { updated: false, valid: false, issues: parsed.issues };
  const parent = parsed.spells[options.mainSpell];
  if (!parent || parent["spell-class"] !== ".MultiSpell" || !Array.isArray(parent.spells)) throw new Error(`${options.mainSpell} is not a .MultiSpell with a spells sequence.`);
  const current = await inspectSpellTimeline(config, options.mainSpell, ticksPerSecond);
  if (current.issues.some((entry) => entry.severity === "error")) return { updated: false, valid: false, issues: current.issues };
  const occurrences = current.occurrences.map((occurrence) => ({ ...occurrence }));
  for (const [helper, value] of Object.entries(options.starts)) {
    const byId = occurrences.find((occurrence) => occurrence.id === helper);
    const matches = byId ? [byId] : occurrences.filter((occurrence) => occurrence.helper === helper);
    if (matches.length === 0) throw new Error(`${helper} is not scheduled by ${options.mainSpell}.`);
    if (matches.length > 1) throw new Error(`${helper} is scheduled more than once; address an occurrence by its id.`);
    const rawTicks = options.unit === "seconds" ? value * ticksPerSecond : value;
    const ticks = Math.round(rawTicks);
    if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks > ticksPerSecond * maximumTimelineSeconds || Math.abs(rawTicks - ticks) > 1e-8) {
      throw new Error(`${helper} start must be a safe value on the ${ticksPerSecond} Hz tick grid within six hours.`);
    }
    matches[0]!.startTicks = ticks;
  }
  const sorted = [...occurrences].sort((left, right) => left.startTicks - right.startTicks || left.sequenceIndex - right.sequenceIndex);
  const sequence: string[] = [];
  let tick = 0;
  for (const occurrence of sorted) {
    const start = occurrence.startTicks;
    if (start > tick) sequence.push(`DELAY ${start - tick}`);
    sequence.push(occurrence.invocation);
    tick = start;
  }
  if (current.endTicks > tick) sequence.push(`DELAY ${current.endTicks - tick}`);
  const node = parsed.document.getIn([options.mainSpell, "spells"], true);
  if (!isSeq(node)) throw new Error(`${options.mainSpell}.spells is not a YAML sequence.`);
  const previous = node as YAMLSeq;
  const replacement = parsed.document.createNode(sequence);
  if (!isSeq(replacement)) throw new Error("Unable to create replacement MagicSpells sequence.");
  const sortedComments = sorted.map((occurrence) => {
    const sourceItem = previous.items[occurrence.sequenceIndex] as { comment?: string | null; commentBefore?: string | null; spaceBefore?: boolean } | undefined;
    const preceding = previous.items[occurrence.sequenceIndex - 1] as { value?: unknown; comment?: string | null; commentBefore?: string | null } | undefined;
    const delayComments = preceding && parseDelay(String(preceding.value ?? "")) !== null
      ? [preceding.commentBefore, preceding.comment].filter((value): value is string => Boolean(value))
      : [];
    return {
      comment: sourceItem?.comment,
      commentBefore: [...delayComments, sourceItem?.commentBefore].filter((value): value is string => Boolean(value)).join("\n") || undefined,
      spaceBefore: sourceItem?.spaceBefore
    };
  });
  let helperNodeIndex = 0;
  for (const item of replacement.items) {
    if (parseDelay(String((item as { value?: unknown }).value ?? "")) !== null) continue;
    const sourceItem = sortedComments[helperNodeIndex++];
    const targetItem = item as { comment?: string | null; commentBefore?: string | null; spaceBefore?: boolean };
    if (sourceItem) {
      targetItem.comment = sourceItem.comment;
      targetItem.commentBefore = sourceItem.commentBefore;
      targetItem.spaceBefore = sourceItem.spaceBefore;
    }
  }
  parsed.document.setIn([options.mainSpell, "spells"], replacement);
  const raw = parsed.document.toString({ lineWidth: 0 });
  const generated = parseYaml(raw);
  if (generated.issues.some((entry) => entry.severity === "error")) throw new Error("Retimed MagicSpells YAML failed validation.");
  const generatedParent = generated.spells[options.mainSpell];
  let generatedTicks = 0;
  if (!generatedParent || !Array.isArray(generatedParent.spells)) throw new Error("Retimed MagicSpells sequence is missing.");
  for (const step of generatedParent.spells) {
    if (typeof step !== "string") throw new Error("Retimed MagicSpells sequence contains a non-string step.");
    const delay = parseDelay(step);
    if (delay !== null) {
      generatedTicks += delay;
      if (!Number.isSafeInteger(delay) || !Number.isSafeInteger(generatedTicks) || generatedTicks > ticksPerSecond * maximumTimelineSeconds) {
        throw new Error("Retimed MagicSpells sequence exceeds the supported timeline range.");
      }
    } else if (!generated.spells[invocationName(step)]) {
      throw new Error(`Retimed MagicSpells sequence references missing helper '${invocationName(step)}'.`);
    }
  }
  const starts = Object.fromEntries(occurrences.map((occurrence) => [occurrence.id, occurrence.startTicks]));
  if (options.dryRun !== false) return { updated: false, dryRun: true, valid: true, sequence, starts, digest: source.digest };
  const write = await writeTextSafely(config.spellFile, raw, options.expectedDigest, config.artifactsRoot, "spell.yml");
  return { updated: true, dryRun: false, valid: true, sequence, starts, write };
}
