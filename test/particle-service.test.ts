import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ParticleStore } from "../src/particle-store.js";
import { patchParticlesBatch, queryParticles } from "../src/particle-service.js";
import { projectFixture, validParticle } from "./fixtures.js";

describe("particle batch service", () => {
  it("projects selected values and collapses common fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-query-"));
    const config = await projectFixture(root);
    await writeFile(path.join(config.particlesRoot, "a.particle.json"), JSON.stringify(validParticle("test:a")));
    await writeFile(path.join(config.particlesRoot, "b.particle.json"), JSON.stringify(validParticle("test:b")));
    const result = await queryParticles(new ParticleStore(config), {
      select: {
        material: "/particle_effect/description/basic_render_parameters/material",
        identifier: "/particle_effect/description/identifier"
      },
      collapseCommon: true
    });
    expect(result.common).toEqual({ material: "particles_alpha" });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ values: { identifier: "test:a" } }),
      expect.objectContaining({ values: { identifier: "test:b" } })
    ]));
  });

  it("writes all valid targets and refuses a stale batch without partial changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-batch-"));
    const config = await projectFixture(root);
    const first = path.join(config.particlesRoot, "a.particle.json");
    const second = path.join(config.particlesRoot, "b.particle.json");
    await writeFile(first, JSON.stringify(validParticle("test:a")));
    await writeFile(second, JSON.stringify(validParticle("test:b")));
    const store = new ParticleStore(config);
    const a = await store.readRaw("a.particle.json");
    const b = await store.readRaw("b.particle.json");
    const operation = { op: "replace" as const, path: "/particle_effect/components/minecraft:emitter_rate_instant/num_particles", value: 5 };
    const result = await patchParticlesBatch(store, config, {
      targets: [
        { file: "a.particle.json", expectedDigest: a.digest, operations: [operation] },
        { file: "b.particle.json", expectedDigest: b.digest, operations: [operation] }
      ],
      dryRun: false
    });
    expect(result.updated).toBe(2);
    const afterA = await store.readRaw("a.particle.json");
    const afterB = await store.readRaw("b.particle.json");
    await expect(patchParticlesBatch(store, config, {
      targets: [
        { file: "a.particle.json", expectedDigest: afterA.digest, operations: [{ ...operation, value: 9 }] },
        { file: "b.particle.json", expectedDigest: "0".repeat(64), operations: [{ ...operation, value: 9 }] }
      ],
      dryRun: false
    })).rejects.toThrow("changed since it was read");
    expect(await readFile(first, "utf8")).toContain('"num_particles": 5');
    expect(await readFile(second, "utf8")).toContain('"num_particles": 5');
    expect(afterB.digest).toBe((await store.readRaw("b.particle.json")).digest);
  });

  it("reports malformed particle files instead of hiding them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-list-"));
    const config = await projectFixture(root);
    await writeFile(path.join(config.particlesRoot, "broken.particle.json"), "{");
    const rows = await new ParticleStore(config).list();
    expect(rows).toEqual([expect.objectContaining({ file: "broken.particle.json", error: expect.any(String) })]);
  });

  it("rejects aliases of the same batch target and stale writes to missing files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-alias-"));
    const config = await projectFixture(root);
    await writeFile(path.join(config.particlesRoot, "a.particle.json"), JSON.stringify(validParticle()));
    const store = new ParticleStore(config);
    const source = await store.readRaw("a.particle.json");
    const operation = { op: "replace" as const, path: "/particle_effect/components/minecraft:emitter_rate_instant/num_particles", value: 3 };
    await expect(patchParticlesBatch(store, config, {
      targets: [
        { file: "a.particle.json", expectedDigest: source.digest, operations: [operation] },
        { file: "sub/../a.particle.json", expectedDigest: source.digest, operations: [operation] }
      ],
      dryRun: true
    })).rejects.toThrow("duplicate resolved targets");
    await expect(store.write("missing.particle.json", validParticle(), "0".repeat(64))).rejects.toThrow("does not exist");
  });

  it("rejects aggregate batch payloads above five MiB", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-payload-"));
    const config = await projectFixture(root);
    const value = "x".repeat(3 * 1024 * 1024);
    await expect(patchParticlesBatch(new ParticleStore(config), config, {
      targets: [{
        file: "missing.particle.json",
        expectedDigest: "0".repeat(64),
        operations: [{ op: "add", path: "/second", value }]
      }],
      commonOperations: [{ op: "add", path: "/first", value }],
      dryRun: true
    })).rejects.toThrow("5 MiB serialized limit");
  });

  it("rejects binding expansion above the shared payload budget before allocation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-binding-"));
    const config = await projectFixture(root);
    await expect(patchParticlesBatch(new ParticleStore(config), config, {
      targets: [{
        file: "missing.particle.json",
        expectedDigest: "0".repeat(64),
        operations: [{ op: "add", path: "/expanded", value: "${A}".repeat(11_000) }]
      }],
      bindings: { A: "x".repeat(512) },
      dryRun: true
    })).rejects.toThrow("Expanded batch operations exceed the shared 5 MiB");
  });
});
