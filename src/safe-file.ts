import { createHash, randomUUID } from "node:crypto";
import { cp, link, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function sha256(raw: string | Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Publishes a new binary asset via a temporary file and atomic no-replace link. */
export async function writeFileSafelyNoOverwrite(
  target: string,
  contents: Buffer | Uint8Array,
  beforePublish?: () => void
): Promise<{ digest: string }> {
  await mkdir(path.dirname(target), { recursive: true });
  return withFileLocks([target], async () => {
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      const temporaryHandle = await open(temporary, "wx");
      try {
        await temporaryHandle.writeFile(contents);
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }

      beforePublish?.();
      try {
        await link(temporary, target);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Refusing to overwrite existing file: ${target}`);
        }
        throw error;
      }
      return { digest: sha256(contents) };
    } finally {
      await rm(temporary, { force: true });
    }
  });
}

export async function readTextWithDigest(file: string): Promise<{ raw: string; digest: string }> {
  const raw = await readFile(file, "utf8");
  return { raw, digest: sha256(raw) };
}

async function acquireLock(target: string) {
  const lock = `${target}.snowstorm-mcp.lock`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
      return { lock, handle };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(
    `Timed out waiting for another Snowstorm MCP write: ${path.basename(target)}. ` +
    `Automatic stale-lock reclamation is disabled to avoid removing an active owner's lock. ` +
    `Verify no Snowstorm MCP writer is running, then remove the lock file manually: ${lock}`
  );
}

export async function writeTextSafely(
  target: string,
  raw: string,
  expectedDigest: string,
  artifactsRoot: string,
  backupName = path.basename(target)
): Promise<{ digest: string; backup: string }> {
  return withFileLocks([target], async () => {
    let temporary: string | undefined;
    try {
      const current = await readFile(target, "utf8");
      if (sha256(current) !== expectedDigest) throw new Error(`File changed since it was read: ${target}`);
      const backupDirectory = path.join(artifactsRoot, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
      const backup = path.join(backupDirectory, backupName);
      await mkdir(path.dirname(backup), { recursive: true });
      await cp(target, backup);
      temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
      await writeFile(temporary, raw, "utf8");
      await rename(temporary, target);
      return { digest: sha256(raw), backup };
    } finally {
      if (temporary) await rm(temporary, { force: true });
    }
  });
}

export async function withFileLocks<T>(targets: string[], operation: () => Promise<T>): Promise<T> {
  const held: Awaited<ReturnType<typeof acquireLock>>[] = [];
  try {
    for (const target of [...new Set(targets)].sort((a, b) => a.localeCompare(b))) held.push(await acquireLock(target));
    return await operation();
  } finally {
    for (const lock of held.reverse()) {
      await lock.handle.close();
      await rm(lock.lock, { force: true });
    }
  }
}
