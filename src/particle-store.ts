import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireResolvedPathInside } from "./config.js";
import type { JsonObject, JsonPatchOperation, JsonValue, ParticleSummary, ProjectConfig } from "./types.js";

function isObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeValues(original: JsonValue | undefined, generated: JsonValue): JsonValue {
  if (isObject(original) && isObject(generated)) {
    const merged: JsonObject = clone(original);
    for (const [key, value] of Object.entries(generated)) merged[key] = mergeValues(original[key], value);
    return merged;
  }
  return clone(generated);
}

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function decodePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
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

function valueAt(document: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = document;
  for (const segment of decodePointer(pointer)) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isObject(current)) current = current[segment];
    else return undefined;
  }
  return current;
}

export function applyPatch(document: JsonObject, operations: JsonPatchOperation[]): JsonObject {
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
          } catch {
            output.push({ file: relative, identifier: null, texture: null, material: null, components: [], blockbusterComponents: [] });
          }
        }
      }
    };
    await walk(this.config.particlesRoot);
    return output.sort((a, b) => a.file.localeCompare(b.file));
  }

  async read(file: string): Promise<JsonObject> {
    const raw = await readFile(this.resolve(file), "utf8");
    const document = JSON.parse(raw) as JsonValue;
    if (!isObject(document)) throw new Error(`Particle root must be a JSON object: ${file}`);
    return document;
  }

  async readRaw(file: string): Promise<{ raw: string; digest: string; document: JsonObject }> {
    const raw = await readFile(this.resolve(file), "utf8");
    const document = JSON.parse(raw) as JsonValue;
    if (!isObject(document)) throw new Error(`Particle root must be a JSON object: ${file}`);
    return { raw, digest: hash(raw), document };
  }

  async write(file: string, document: JsonObject, expectedDigest?: string): Promise<{ digest: string; backup?: string }> {
    const target = this.resolve(file);
    return this.withLock(target, async () => this.writeLocked(file, target, document, expectedDigest));
  }

  async create(file: string, document: JsonObject): Promise<{ digest: string }> {
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
      return { digest: hash(raw) };
    });
  }

  private async writeLocked(file: string, target: string, document: JsonObject, expectedDigest?: string): Promise<{ digest: string; backup?: string }> {
    let oldRaw: string | undefined;
    try {
      oldRaw = await readFile(target, "utf8");
    } catch {
      // New particle files do not have a previous revision.
    }
    if (expectedDigest && oldRaw && hash(oldRaw) !== expectedDigest) {
      throw new Error(`Particle changed since it was read: ${file}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    let backup: string | undefined;
    if (oldRaw !== undefined) {
      const backupDirectory = path.join(this.config.artifactsRoot, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
      await mkdir(backupDirectory, { recursive: true });
      backup = path.join(backupDirectory, file);
      await mkdir(path.dirname(backup), { recursive: true });
      await cp(target, backup);
    }
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    await writeFile(temporary, raw, "utf8");
    await rename(temporary, target);
    return { digest: hash(raw), backup };
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
