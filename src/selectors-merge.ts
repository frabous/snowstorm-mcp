import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256, withFileLocks } from "./safe-file.js";
import type { ProjectConfig } from "./types.js";

type Selector = Record<string, unknown>;

interface ParsedSelector {
  index: number;
  selector: Selector;
  name: string;
  scheme: string;
  canonical: string;
}

export interface SelectorsMergeOptions {
  instanceFile?: string;
  dryRun?: boolean;
  expectedDigest?: string;
  write?: boolean;
}

function isObject(value: unknown): value is Selector {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseSelectorArray(raw: string, label: string): ParsedSelector[] {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse ${label} as JSON: ${String(error)}`);
  }
  if (!Array.isArray(value)) throw new Error(`${label} must contain a JSON array of selectors.`);

  return value.map((entry: unknown, index: number) => {
    if (!isObject(entry)) throw new Error(`${label} selector at index ${index} must be an object.`);
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(`${label} selector at index ${index} must have a non-empty name.`);
    }
    if (typeof entry.morph !== "string") {
      throw new Error(`${label} selector '${entry.name}' must have a morph string.`);
    }
    const scheme = /Scheme:\s*"([^"]+)"/.exec(entry.morph)?.[1];
    if (!scheme) throw new Error(`${label} selector '${entry.name}' has no parseable Scheme in morph.`);
    return { index, selector: entry, name: entry.name, scheme, canonical: canonicalJson(entry) };
  });
}

function mergeArrays(existing: ParsedSelector[], additions: ParsedSelector[]) {
  const added: Selector[] = [];
  const alreadyPresent: Array<{ fragmentIndex: number; existingIndex: number; selector: Selector }> = [];
  const conflicts: Array<{
    fragmentIndex: number;
    selector: Selector;
    existing: Array<{ source: "instance" | "fragment"; index: number; selector: Selector; reasons: Array<"name" | "scheme"> }>;
  }> = [];
  const accepted: Array<{ source: "instance" | "fragment"; entry: ParsedSelector }> = existing.map((entry) => ({ source: "instance", entry }));

  for (const incoming of additions) {
    const exact = existing.find((entry) => entry.canonical === incoming.canonical);
    if (exact) {
      alreadyPresent.push({ fragmentIndex: incoming.index, existingIndex: exact.index, selector: incoming.selector });
      continue;
    }

    const collisions = accepted.flatMap(({ source, entry }) => {
      const reasons: Array<"name" | "scheme"> = [];
      if (entry.name === incoming.name) reasons.push("name");
      if (entry.scheme === incoming.scheme) reasons.push("scheme");
      return reasons.length ? [{ source, index: entry.index, selector: entry.selector, reasons }] : [];
    });
    if (collisions.length) {
      conflicts.push({ fragmentIndex: incoming.index, selector: incoming.selector, existing: collisions });
      continue;
    }

    added.push(incoming.selector);
    accepted.push({ source: "fragment", entry: incoming });
  }

  const existingOnly = existing
    .filter((entry) => !additions.some((incoming) => incoming.name === entry.name || incoming.scheme === entry.scheme))
    .map((entry) => ({ existingIndex: entry.index, selector: entry.selector }));
  const merged = [...existing.map((entry) => entry.selector), ...added];
  const mergedRaw = `${JSON.stringify(merged, null, 2)}\n`;
  return {
    added,
    alreadyPresent,
    conflicts,
    existingOnly,
    merged,
    mergedRaw,
    counts: {
      fragmentSelectors: additions.length,
      instanceSelectors: existing.length,
      added: added.length,
      alreadyPresent: alreadyPresent.length,
      conflicts: conflicts.length,
      existingOnly: existingOnly.length,
      orphans: existingOnly.length
    }
  };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function atomicWriteWithBackup(
  target: string,
  raw: string,
  artifactsRoot: string,
  beforeWrite?: () => void
): Promise<{ digest: string; backup: string }> {
  const backupDirectory = path.join(artifactsRoot, "backups", `${timestamp()}-${randomUUID().slice(0, 8)}`);
  const backup = path.join(backupDirectory, path.basename(target));
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  await mkdir(backupDirectory, { recursive: true });
  beforeWrite?.();
  await cp(target, backup);
  try {
    await writeFile(temporary, raw, "utf8");
    beforeWrite?.();
    await rename(temporary, target);
    return { digest: sha256(raw), backup };
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function mergeSelectors(
  config: ProjectConfig,
  options: SelectorsMergeOptions = {},
  beforeWrite?: () => void
) {
  const dryRun = options.dryRun ?? true;
  const writeRequested = options.write ?? false;
  if (options.instanceFile !== undefined && !options.instanceFile.trim()) {
    throw new Error("instanceFile must be a non-empty path.");
  }
  const target = options.instanceFile !== undefined
    ? path.resolve(path.dirname(config.configPath), options.instanceFile)
    : config.instanceSelectorsFile;
  if (!target) {
    throw new Error("No instance selectors file was provided. Pass instanceFile or configure instanceSelectorsFile.");
  }
  if (writeRequested && !dryRun && !options.expectedDigest) {
    throw new Error("expectedDigest is required when write is true and dryRun is false.");
  }
  if (writeRequested && !dryRun) {
    if (!config.instanceSelectorsFile) {
      throw new Error("Configure instanceSelectorsFile before writing merged selectors to disk.");
    }
    const configuredTarget = path.resolve(config.instanceSelectorsFile);
    const normalizeTarget = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    if (normalizeTarget(target) !== normalizeTarget(configuredTarget)) {
      throw new Error("Live selectors_merge writes must target the configured instanceSelectorsFile.");
    }
  }
  if (writeRequested && !dryRun && !/^[a-f0-9]{64}$/i.test(options.expectedDigest ?? "")) {
    throw new Error("expectedDigest must be a 64-character SHA-256 hex digest.");
  }

  const [fragmentRaw, targetRaw] = await Promise.all([
    readFile(config.selectorsFile, "utf8").catch((error: unknown) => {
      throw new Error(`Unable to read selectors fragment '${config.selectorsFile}': ${String(error)}`);
    }),
    readFile(target, "utf8").catch((error: unknown) => {
      throw new Error(`Unable to read instance selectors file '${target}': ${String(error)}`);
    })
  ]);
  const fragment = parseSelectorArray(fragmentRaw, `Selectors fragment '${config.selectorsFile}'`);
  const original = parseSelectorArray(targetRaw, `Instance selectors file '${target}'`);
  let merged = mergeArrays(original, fragment);
  const fragmentDigest = sha256(fragmentRaw);
  let digestBefore = sha256(targetRaw);
  let digestAfter = digestBefore;
  let backup: string | undefined;
  let written = false;

  if (writeRequested && !dryRun) {
    const writeResult = await withFileLocks([target], async () => {
      const lockedRaw = await readFile(target, "utf8");
      const lockedDigest = sha256(lockedRaw);
      if (lockedDigest !== options.expectedDigest) {
        throw new Error(`Instance selectors file changed since it was read: ${target}`);
      }
      const lockedExisting = parseSelectorArray(lockedRaw, `Instance selectors file '${target}'`);
      const lockedMerge = mergeArrays(lockedExisting, fragment);
      if (!lockedMerge.added.length) return { digestBefore: lockedDigest, digestAfter: lockedDigest, backup: undefined, merged: lockedMerge, written: false };
      const write = await atomicWriteWithBackup(target, lockedMerge.mergedRaw, config.artifactsRoot, beforeWrite);
      return { digestBefore: lockedDigest, digestAfter: write.digest, backup: write.backup, merged: lockedMerge, written: true };
    });
    digestBefore = writeResult.digestBefore;
    digestAfter = writeResult.digestAfter;
    backup = writeResult.backup;
    merged = writeResult.merged;
    written = writeResult.written;
  }

  const reportFile = dryRun
    ? path.join(config.artifactsRoot, "selectors-merge", `selectors-merge-${timestamp()}-${randomUUID().slice(0, 8)}.json`)
    : undefined;
  const result = {
    dryRun,
    writeRequested,
    written,
    fragmentFile: config.selectorsFile,
    instanceFile: target,
    fragmentDigest,
    digestBefore,
    digestAfter,
    mergedDigest: sha256(merged.mergedRaw),
    added: merged.added,
    alreadyPresent: merged.alreadyPresent,
    conflicts: merged.conflicts,
    existingOnly: merged.existingOnly,
    orphans: merged.existingOnly,
    merged: merged.merged,
    counts: merged.counts,
    ...(backup ? { backup } : {}),
    ...(reportFile ? { reportFile } : {})
  };

  if (reportFile) {
    await mkdir(path.dirname(reportFile), { recursive: true });
    beforeWrite?.();
    await writeFile(reportFile, `${JSON.stringify({ ...result, proposedMerged: merged.merged }, null, 2)}\n`, "utf8");
  }
  return result;
}
