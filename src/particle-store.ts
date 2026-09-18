import { randomUUID } from "node:crypto";
import { cp, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireResolvedPathInside } from "./config.js";
import { sha256, withFileLocks } from "./safe-file.js";
import type { JsonObject, JsonPatchOperation, JsonValue, ParticleSummary, ProjectConfig } from "./types.js";

function isObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function assertJsonWithinLimits(value: unknown, label = "JSON value"): void {
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const active = new Set<object>();
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > 64) throw new Error(`${label} exceeds the maximum nesting depth of 64.`);
    if (!current.value || typeof current.value !== "object") continue;
    if (current.exit) {
      active.delete(current.value);
      continue;
    }
    if (active.has(current.value)) throw new Error(`${label} must not contain cycles.`);
    active.add(current.value);
    nodes += 1;
    if (nodes > 100_000) throw new Error(`${label} exceeds the maximum object/array node count.`);
    stack.push({ ...current, exit: true });
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} is not serializable: ${String(error)}`);
  }
  if (Buffer.byteLength(raw) > 5 * 1024 * 1024) throw new Error(`${label} exceeds the 5 MiB serialized limit.`);
}

function mergeValues(original: JsonValue | undefined, generated: JsonValue): JsonValue {
  if (isObject(original) && isObject(generated)) {
    const merged: JsonObject = clone(original);
    for (const [key, value] of Object.entries(generated)) merged[key] = mergeValues(original[key], value);
    return merged;
  }
  return clone(generated);
}

function decodePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON pointer: ${pointer}`);
  const segments = pointer.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.some((segment) => segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    throw new Error(`Unsafe JSON pointer segment: ${pointer}`);
  }
  return segments;
}

function parentAt(document: JsonValue, pointer: string): { parent: JsonObject | JsonValue[]; key: string } {
  const segments = decodePointer(pointer);
  if (segments.length === 0) throw new Error("Replacing the entire particle document is not supported.");
  const key = segments.pop()!;
  let current: JsonValue = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) throw new Error(`JSON pointer does not exist: ${pointer}`);
      current = current[index]!;
    } else if (isObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment]!;
    } else {
      throw new Error(`JSON pointer does not exist: ${pointer}`);
    }
  }
  if (!Array.isArray(current) && !isObject(current)) throw new Error(`JSON pointer parent is not a container: ${pointer}`);
  return { parent: current, key };
}

export function valueAt(document: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = document;
  for (const segment of decodePointer(pointer)) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isObject(current) && Object.hasOwn(current, segment)) current = current[segment];
    else return undefined;
  }
  return current;
}

export function applyPatch(document: JsonObject, operations: JsonPatchOperation[]): JsonObject {
  assertJsonWithinLimits(document, "Particle document");
  for (const operation of operations) if (operation.value !== undefined) assertJsonWithinLimits(operation.value, `Patch value at ${operation.path}`);
  const output = clone(document);
  for (const operation of operations) {
    const { parent, key } = parentAt(output, operation.path);
    if (operation.op === "test") {
      if (JSON.stringify(valueAt(output, operation.path)) !== JSON.stringify(operation.value)) {
        throw new Error(`JSON patch test failed at ${operation.path}`);
      }
      continue;
    }
    if (Array.isArray(parent)) {
      const index = key === "-" ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new Error(`Invalid array index at ${operation.path}`);
      if (operation.op === "remove") {
        if (index === parent.length) throw new Error(`Array item does not exist at ${operation.path}`);
        parent.splice(index, 1);
      } else if (operation.op === "add") {
        parent.splice(index, 0, clone(operation.value!));
      } else {
        if (index === parent.length) throw new Error(`Array item does not exist at ${operation.path}`);
        parent[index] = clone(operation.value!);
      }
    } else if (operation.op === "remove") {
      if (!Object.hasOwn(parent, key)) throw new Error(`Object property does not exist at ${operation.path}`);
      delete parent[key];
    } else if (operation.op === "replace") {
      if (!Object.hasOwn(parent, key)) throw new Error(`Object property does not exist at ${operation.path}`);
      parent[key] = clone(operation.value!);
    } else {
      parent[key] = clone(operation.value!);
    }
  }
  assertJsonWithinLimits(output, "Patched particle document");
  return output;
}

export function summarizeParticle(document: JsonObject, file: string): ParticleSummary {
  const effect = isObject(document.particle_effect) ? document.particle_effect : undefined;
  const description = effect && isObject(effect.description) ? effect.description : undefined;
  const parameters = description && isObject(description.basic_render_parameters) ? description.basic_render_parameters : undefined;
  const components = effect && isObject(effect.components) ? Object.keys(effect.components).sort() : [];
  return {
    file,
    identifier: typeof description?.identifier === "string" ? description.identifier : null,
    texture: typeof parameters?.texture === "string" ? parameters.texture : null,
    material: typeof parameters?.material === "string" ? parameters.material : null,
    components,
    blockbusterComponents: components.filter((component) => component.startsWith("blockbuster:"))
  };
}

export function mergeSnowstormExport(original: JsonObject, generated: JsonObject): JsonObject {
  const merged = mergeValues(original, generated) as JsonObject;
  const originalEffect = isObject(original.particle_effect) ? original.particle_effect : undefined;
  const generatedEffect = isObject(generated.particle_effect) ? generated.particle_effect : undefined;
  const mergedEffect = isObject(merged.particle_effect) ? merged.particle_effect : undefined;
  if (originalEffect && generatedEffect && mergedEffect && isObject(originalEffect.components) && isObject(generatedEffect.components)) {
    const preservedExtensions = Object.fromEntries(Object.entries(originalEffect.components).filter(([name]) => !name.startsWith("minecraft:")));
    mergedEffect.components = { ...preservedExtensions, ...generatedEffect.components };
  }
  return merged;
}

export class ParticleStore {
  constructor(private readonly config: ProjectConfig) {}

  resolve(file: string): string {
    if (!file.endsWith(".particle.json")) throw new Error("Particle files must end with .particle.json.");
    return requireResolvedPathInside(this.config.particlesRoot, file);
  }

  async list(): Promise<ParticleSummary[]> {
    const output: ParticleSummary[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile() && entry.name.endsWith(".particle.json")) {
          const relative = path.relative(this.config.particlesRoot, target).replaceAll(path.sep, "/");
          try {
            output.push(summarizeParticle(await this.read(relative), relative));
          } catch (error) {
            output.push({ file: relative, identifier: null, texture: null, material: null, components: [], blockbusterComponents: [], error: String(error) });
          }
        }
      }
    };
    await walk(this.config.particlesRoot);
    return output.sort((a, b) => a.file.localeCompare(b.file));
  }

  async listFiles(): Promise<string[]> {
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile() && entry.name.endsWith(".particle.json")) {
          files.push(path.relative(this.config.particlesRoot, target).replaceAll(path.sep, "/"));
        }
      }
    };
    await walk(this.config.particlesRoot);
    return files.sort((a, b) => a.localeCompare(b));
  }

  async read(file: string): Promise<JsonObject> {
    const raw = await readFile(this.resolve(file), "utf8");
    if (Buffer.byteLength(raw) > 5 * 1024 * 1024) throw new Error(`Particle exceeds the 5 MiB serialized limit: ${file}`);
    const document = JSON.parse(raw) as JsonValue;
    if (!isObject(document)) throw new Error(`Particle root must be a JSON object: ${file}`);
    assertJsonWithinLimits(document, `Particle document ${file}`);
    return document;
  }

  async readRaw(file: string): Promise<{ raw: string; digest: string; document: JsonObject }> {
    const raw = await readFile(this.resolve(file), "utf8");
    if (Buffer.byteLength(raw) > 5 * 1024 * 1024) throw new Error(`Particle exceeds the 5 MiB serialized limit: ${file}`);
    const document = JSON.parse(raw) as JsonValue;
    if (!isObject(document)) throw new Error(`Particle root must be a JSON object: ${file}`);
    assertJsonWithinLimits(document, `Particle document ${file}`);
    return { raw, digest: sha256(raw), document };
  }

  async write(file: string, document: JsonObject, expectedDigest?: string): Promise<{ digest: string; backup?: string }> {
    const target = this.resolve(file);
    return this.withLock(target, async () => this.writeLocked(file, target, document, expectedDigest));
  }

  async create(file: string, document: JsonObject): Promise<{ digest: string }> {
    assertJsonWithinLimits(document, "Particle document");
    const target = this.resolve(file);
    return this.withLock(target, async () => {
      await mkdir(path.dirname(target), { recursive: true });
      const raw = `${JSON.stringify(document, null, 2)}\n`;
      const handle = await open(target, "wx");
      try {
        await handle.writeFile(raw, "utf8");
      } finally {
        await handle.close();
      }
      return { digest: sha256(raw) };
    });
  }

  private async writeLocked(file: string, target: string, document: JsonObject, expectedDigest?: string): Promise<{ digest: string; backup?: string }> {
    assertJsonWithinLimits(document, "Particle document");
    let oldRaw: string;
    try {
      oldRaw = await readFile(target, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Particle does not exist: ${file}`);
      throw error;
    }
    if (expectedDigest && sha256(oldRaw) !== expectedDigest) {
      throw new Error(`Particle changed since it was read: ${file}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    const backupDirectory = path.join(this.config.artifactsRoot, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
    await mkdir(backupDirectory, { recursive: true });
    const relative = path.relative(await realpath(this.config.particlesRoot), target);
    const backup = requireResolvedPathInside(backupDirectory, relative);
    await mkdir(path.dirname(backup), { recursive: true });
    await cp(target, backup);
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, raw, "utf8");
      await rename(temporary, target);
      return { digest: sha256(raw), backup };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async writeBatch(entries: Array<{ file: string; document: JsonObject; expectedDigest: string }>): Promise<{
    writes: Array<{ file: string; digest: string; backup: string }>;
    rolledBack: boolean;
  }> {
    if (entries.length === 0) throw new Error("Batch write requires at least one particle.");
    const resolved = entries.map((entry) => ({ ...entry, target: this.resolve(entry.file) }));
    const targetKeys = resolved.map((entry) => process.platform === "win32" ? entry.target.toLowerCase() : entry.target);
    if (new Set(targetKeys).size !== targetKeys.length) throw new Error("Batch write contains duplicate resolved particle files.");
    return withFileLocks(resolved.map((entry) => entry.target), async () => {
      for (const entry of resolved) assertJsonWithinLimits(entry.document, `Particle document ${entry.file}`);
      const prepared = [] as Array<typeof resolved[number] & { oldRaw: string; raw: string; temporary: string; backup: string }>;
      const backupDirectory = path.join(this.config.artifactsRoot, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
      await mkdir(backupDirectory, { recursive: true });
      const canonicalParticlesRoot = await realpath(this.config.particlesRoot);
      try {
        for (const entry of resolved) {
          const oldRaw = await readFile(entry.target, "utf8");
          if (sha256(oldRaw) !== entry.expectedDigest) throw new Error(`Particle changed since it was read: ${entry.file}`);
          const raw = `${JSON.stringify(entry.document, null, 2)}\n`;
          const temporary = path.join(path.dirname(entry.target), `.${path.basename(entry.target)}.${randomUUID()}.tmp`);
          const relative = path.relative(canonicalParticlesRoot, entry.target);
          const backup = requireResolvedPathInside(backupDirectory, relative);
          await mkdir(path.dirname(backup), { recursive: true });
          await cp(entry.target, backup);
          await writeFile(temporary, raw, "utf8");
          prepared.push({ ...entry, oldRaw, raw, temporary, backup });
        }
        const written: typeof prepared = [];
        try {
          for (const entry of prepared) {
            await rename(entry.temporary, entry.target);
            written.push(entry);
          }
        } catch (error) {
          const rollbackResults = await Promise.allSettled(written.reverse().map(async (entry) => {
            const rollback = path.join(path.dirname(entry.target), `.${path.basename(entry.target)}.${randomUUID()}.rollback`);
            try {
              await writeFile(rollback, entry.oldRaw, "utf8");
              await rename(rollback, entry.target);
            } finally {
              await rm(rollback, { force: true });
            }
          }));
          const rollbackFailures = rollbackResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
          if (rollbackFailures.length) throw new AggregateError([error, ...rollbackFailures], "Batch commit failed and one or more rollback operations also failed.");
          throw error;
        }
        return {
          writes: prepared.map((entry) => ({ file: entry.file, digest: sha256(entry.raw), backup: entry.backup })),
          rolledBack: false
        };
      } finally {
        await Promise.all(prepared.map((entry) => rm(entry.temporary, { force: true })));
      }
    });
  }

  private async withLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
    const lock = `${target}.snowstorm-mcp.lock`;
    let handle;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        handle = await open(lock, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.reclaimStaleLock(lock);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!handle) throw new Error(`Timed out waiting for another Snowstorm MCP write: ${path.basename(target)}`);
    try {
      return await operation();
    } finally {
      await handle.close();
      await rm(lock, { force: true });
    }
  }

  private async reclaimStaleLock(lock: string): Promise<void> {
    try {
      const metadata = JSON.parse(await readFile(lock, "utf8")) as { pid?: number; createdAt?: number };
      if (!metadata.pid || !metadata.createdAt || Date.now() - metadata.createdAt < 30_000) return;
      try {
        process.kill(metadata.pid, 0);
        return;
      } catch {
        await rm(lock, { force: true });
      }
    } catch {
      // An unreadable lock is left intact until its owner releases it.
    }
  }

  async exists(file: string): Promise<boolean> {
    try {
      await stat(this.resolve(file));
      return true;
    } catch {
      return false;
    }
  }
}
