import type { JsonObject, JsonPatchOperation, JsonValue, ProjectConfig } from "./types.js";
import { applyPatch, assertJsonWithinLimits, ParticleStore, summarizeParticle, valueAt } from "./particle-store.js";
import { validateParticle } from "./validator.js";

export interface ParticleQueryOptions {
  files?: string[];
  nameContains?: string;
  identifierContains?: string;
  texture?: string;
  components?: string[];
  select?: Record<string, string>;
  collapseCommon?: boolean;
}

function sameValue(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function jsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function projectedExpandedBytes(value: JsonValue, bindings: Record<string, string>): number {
  if (typeof value === "string") {
    let bytes = 2;
    let cursor = 0;
    const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    for (const match of value.matchAll(pattern)) {
      const index = match.index ?? 0;
      bytes += jsonStringBytes(value.slice(cursor, index)) - 2;
      bytes += jsonStringBytes(bindings[match[1]!] ?? match[0]) - 2;
      cursor = index + match[0].length;
    }
    return bytes + jsonStringBytes(value.slice(cursor)) - 2;
  }
  if (value === null || typeof value !== "object") return Buffer.byteLength(JSON.stringify(value));
  if (Array.isArray(value)) {
    let bytes = 2 + Math.max(0, value.length - 1);
    for (const entry of value) bytes += projectedExpandedBytes(entry, bindings);
    return bytes;
  }
  const entries = Object.entries(value);
  let bytes = 2 + Math.max(0, entries.length - 1);
  for (const [key, entry] of entries) bytes += jsonStringBytes(key) + 1 + projectedExpandedBytes(entry, bindings);
  return bytes;
}

export async function queryParticles(store: ParticleStore, options: ParticleQueryOptions) {
  const files = options.files ?? await store.listFiles();
  const items = [] as Array<{
    file: string;
    digest?: string;
    summary?: ReturnType<typeof summarizeParticle>;
    values?: Record<string, JsonValue | null>;
    error?: string;
  }>;
  for (const file of files) {
    try {
      const source = await store.readRaw(file);
      const summary = summarizeParticle(source.document, file);
      const needle = options.nameContains?.toLowerCase();
      if (needle && !file.toLowerCase().includes(needle) && !summary.identifier?.toLowerCase().includes(needle)) continue;
      if (options.identifierContains && !summary.identifier?.toLowerCase().includes(options.identifierContains.toLowerCase())) continue;
      if (options.texture && summary.texture !== options.texture) continue;
      if (options.components?.some((component) => !summary.components.includes(component))) continue;
      const values = options.select
        ? Object.fromEntries(Object.entries(options.select).map(([label, pointer]) => [label, valueAt(source.document, pointer) ?? null]))
        : undefined;
      items.push({ file, digest: source.digest, summary, values });
    } catch (error) {
      items.push({ file, error: String(error) });
    }
  }
  const common: Record<string, JsonValue | null> = {};
  if (options.collapseCommon && items.length > 1 && options.select && items.every((item) => item.values)) {
    for (const label of Object.keys(options.select)) {
      const first = items[0]!.values![label];
      if (items.every((item) => sameValue(item.values![label], first))) {
        common[label] = first ?? null;
        for (const item of items) delete item.values![label];
      }
    }
  }
  return { count: items.length, common: Object.keys(common).length ? common : undefined, items };
}

function expandBindings(value: JsonValue | undefined, bindings: Record<string, string>): JsonValue | undefined {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => bindings[name] ?? match);
  }
  if (Array.isArray(value)) return value.map((entry) => expandBindings(entry, bindings)!) as JsonValue;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandBindings(entry, bindings)!]));
  }
  return value;
}

function expandOperations(operations: JsonPatchOperation[], bindings: Record<string, string>): JsonPatchOperation[] {
  return operations.map((operation) => operation.op === "remove"
    ? operation
    : { ...operation, value: expandBindings(operation.value, bindings) });
}

export interface BatchPatchTarget {
  file: string;
  expectedDigest: string;
  operations?: JsonPatchOperation[];
}

export async function patchParticlesBatch(
  store: ParticleStore,
  config: ProjectConfig,
  options: {
    targets: BatchPatchTarget[];
    commonOperations?: JsonPatchOperation[];
    bindings?: Record<string, string>;
    dryRun?: boolean;
  }
) {
  assertJsonWithinLimits(options, "Batch patch request");
  const targetKeys = options.targets.map((target) => {
    const resolved = store.resolve(target.file);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  });
  if (new Set(targetKeys).size !== options.targets.length) throw new Error("Batch patch contains duplicate resolved targets.");
  const bindings = options.bindings ?? {};
  const projectedBytes = options.targets.reduce((total, target) => {
    return total + projectedExpandedBytes([...options.commonOperations ?? [], ...target.operations ?? []] as unknown as JsonValue, bindings);
  }, 0);
  if (projectedBytes > 5 * 1024 * 1024) throw new Error("Expanded batch operations exceed the shared 5 MiB serialized limit.");
  const common = expandOperations(options.commonOperations ?? [], bindings);
  const prepared = [] as Array<{
    file: string;
    expectedDigest: string;
    document: JsonObject;
    operations: number;
    validation: Awaited<ReturnType<typeof validateParticle>>;
  }>;
  for (const target of options.targets) {
    const source = await store.readRaw(target.file);
    if (source.digest !== target.expectedDigest) throw new Error(`Particle changed since it was read: ${target.file}`);
    const operations = [...common, ...expandOperations(target.operations ?? [], bindings)];
    if (operations.length === 0) throw new Error(`No operations supplied for ${target.file}.`);
    const document = applyPatch(source.document, operations);
    const validation = await validateParticle(document, config, target.file);
    prepared.push({ file: target.file, expectedDigest: target.expectedDigest, document, operations: operations.length, validation });
  }
  const valid = prepared.every((entry) => entry.validation.valid);
  const summary = prepared.map((entry) => ({
    file: entry.file,
    operations: entry.operations,
    errors: entry.validation.issues.filter((issue) => issue.severity === "error"),
    warnings: entry.validation.issues.filter((issue) => issue.severity === "warning")
  }));
  if (!valid || options.dryRun !== false) return { updated: 0, dryRun: true, valid, targets: prepared.length, results: summary };
  const write = await store.writeBatch(prepared.map(({ file, document, expectedDigest }) => ({ file, document, expectedDigest })));
  return { updated: write.writes.length, dryRun: false, valid: true, rolledBack: write.rolledBack, writes: write.writes, results: summary };
}
