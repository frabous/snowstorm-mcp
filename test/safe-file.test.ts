import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256, withFileLocks, writeFileSafelyNoOverwrite } from "../src/safe-file.js";
import { ParticleStore } from "../src/particle-store.js";
import { projectFixture, validParticle } from "./fixtures.js";

describe("shared file locks", () => {
  it("serializes operations on the same target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-lock-"));
    const target = path.join(root, "asset.json");
    const events: string[] = [];
    let enteredFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    try {
      const first = withFileLocks([target], async () => {
        events.push("first-start");
        enteredFirst();
        await firstGate;
        events.push("first-end");
      });
      await firstEntered;
      const second = withFileLocks([target], async () => { events.push("second"); });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(events).toEqual(["first-start"]);
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(["first-start", "first-end", "second"]);
    } finally {
      releaseFirst();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reclaim stale locks automatically and gives safe recovery guidance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-stale-lock-"));
    const target = path.join(root, "asset.json");
    const lock = `${target}.snowstorm-mcp.lock`;
    const staleMetadata = JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, createdAt: Date.now() - 60_000 });
    let operationStarted = false;

    try {
      await writeFile(lock, staleMetadata, "utf8");

      let failure: unknown;
      try {
        await withFileLocks([target], async () => { operationStarted = true; });
      } catch (error: unknown) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("Automatic stale-lock reclamation is disabled");
      expect((failure as Error).message).toContain("Verify no Snowstorm MCP writer is running");
      expect((failure as Error).message).toContain(lock);
      expect(operationStarted).toBe(false);
      await expect(readFile(lock, "utf8")).resolves.toBe(staleMetadata);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 7_000);

  it("lets ParticleStore create and update through the shared lock path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-store-lock-"));
    try {
      const config = await projectFixture(root);
      const store = new ParticleStore(config);
      const file = "locked.particle.json";
      const initial = validParticle("test:initial");
      const created = await store.create(file, initial);
      const updated = validParticle("test:updated");

      await expect(store.write(file, updated, created.digest)).resolves.toMatchObject({ digest: expect.any(String) });
      await expect(store.read(file)).resolves.toEqual(updated);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("safe binary publication", () => {
  it("does not publish a staged file when the pre-publish guard rejects it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-publish-"));
    const target = path.join(root, "asset.bin");

    try {
      await expect(writeFileSafelyNoOverwrite(target, Buffer.from("asset"), () => {
        throw new Error("project config changed");
      })).rejects.toThrow("project config changed");
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes one complete file under concurrent no-overwrite attempts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-publish-"));
    const target = path.join(root, "asset.bin");
    const contents = Array.from({ length: 8 }, (_, index) => Buffer.alloc(512 * 1024, index + 1));
    let observing = true;
    let emptyReads = 0;
    const readers = Array.from({ length: 3 }, async () => {
      while (observing) {
        try {
          const visible = await readFile(target);
          if (visible.length === 0) emptyReads += 1;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    });

    try {
      const results = await Promise.allSettled(contents.map((bytes) => writeFileSafelyNoOverwrite(target, bytes)));
      observing = false;
      await Promise.all(readers);

      const published = await readFile(target);
      const winner = contents.find((candidate) => candidate.equals(published));
      const successes = results.filter((result) => result.status === "fulfilled");
      const refusals = results.filter((result) => result.status === "rejected");

      expect(successes).toHaveLength(1);
      expect(refusals).toHaveLength(contents.length - 1);
      for (const refusal of refusals) {
        expect(refusal.reason.message).toContain("Refusing to overwrite existing file");
      }
      expect(winner).toBeDefined();
      expect(successes[0]).toMatchObject({ status: "fulfilled", value: { digest: sha256(published) } });
      expect(emptyReads).toBe(0);
    } finally {
      observing = false;
      await Promise.all(readers);
      await rm(root, { recursive: true, force: true });
    }
  });
});
