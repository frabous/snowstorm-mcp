import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateTexture } from "../src/texture-generator.js";
import {
  generateTextureAsset,
  importTextureAsset,
  inspectTexture,
  listTextures,
  textureFlipbookAtlas
} from "../src/texture.js";
import { sha256 } from "../src/safe-file.js";
import type { ParticleSummary } from "../src/types.js";
import { png1x1, projectFixture } from "./fixtures.js";

async function textureFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-textures-"));
  const config = await projectFixture(root);
  const bank = path.join(root, "shared-bank");
  config.sharedTextureBanks = [bank];
  await mkdir(bank, { recursive: true });
  return { root, bank, config };
}

describe("texture roots and metadata", () => {
  it("resolves project textures before bank collisions and falls back to a bank", async () => {
    const { bank, config } = await textureFixture();
    const projectTexture = path.join(config.resourcePackRoot, "assets", "test", "textures", "particles", "test.png");
    const bankTexture = path.join(bank, "test", "particles", "test.png");
    await mkdir(path.dirname(bankTexture), { recursive: true });
    await writeFile(bankTexture, png1x1);

    const projectWinner = await inspectTexture("test:particles/test", config);
    expect(projectWinner.source).toEqual({ kind: "project", root: config.resourcePackRoot });
    expect(projectWinner.shadowedSources).toEqual([{ kind: "shared_bank", root: bank, bankIndex: 0 }]);

    await rm(projectTexture);
    const bankWinner = await inspectTexture("test:particles/test", config);
    expect(bankWinner.source).toEqual({ kind: "shared_bank", root: bank, bankIndex: 0 });
    expect(bankWinner.path).toBe(bankTexture);
    expect(bankWinner.shadowedSources).toEqual([]);
  });

  it("measures decoded PNG pixels and invalidates cached metadata when file contents change", async () => {
    const { config } = await textureFixture();
    const target = path.join(config.resourcePackRoot, "assets", "test", "textures", "particles", "test.png");
    const firstPng = await generateTexture({ primitive: "puff", width: 48, height: 48, seed: 1 });
    await writeFile(target, firstPng.bytes);
    const fixedTime = new Date(1_700_000_000_000);
    await utimes(target, fixedTime, fixedTime);

    const first = await inspectTexture("test:particles/test", config);
    const cached = await inspectTexture("test:particles/test", config);
    expect(first.nonZeroCoverage).toBe(firstPng.alphaCoverage);
    expect(first.brightCoverage).toBe(firstPng.brightCoverage);
    expect(first.hasAlpha).toBe(firstPng.hasAlpha);
    expect(cached.nonZeroCoverage).toBe(first.nonZeroCoverage);
    expect(cached.brightCoverage).toBe(first.brightCoverage);

    await writeFile(target, Buffer.alloc(firstPng.bytes.length));
    await utimes(target, fixedTime, fixedTime);
    expect((await stat(target)).mtimeMs).toBe(fixedTime.getTime());
    await expect(inspectTexture("test:particles/test", config)).rejects.toThrow("not a valid PNG");

    const secondPng = await generateTexture({ primitive: "beam_core", width: 48, height: 48, seed: 2 });
    await writeFile(target, secondPng.bytes);
    await utimes(target, new Date(), new Date(Date.now() + 5_000));
    const changed = await inspectTexture("test:particles/test", config);
    expect(changed.nonZeroCoverage).toBe(secondPng.alphaCoverage);
    expect(changed.brightCoverage).toBe(secondPng.brightCoverage);
  });
});

describe("texture catalogue", () => {
  it("applies metadata and usedBy filters while exposing project-first deduplication", async () => {
    const { bank, config } = await textureFixture();
    const projectEntry = await generateTextureAsset(config, {
      texture: "test:catalog/leaf",
      primitive: "puff",
      width: 40,
      height: 40,
      seed: 9
    });
    const bankEntry = path.join(bank, "TEST", "CATALOG", "LEAF.png");
    await mkdir(path.dirname(bankEntry), { recursive: true });
    await writeFile(bankEntry, png1x1);

    const particles: ParticleSummary[] = [{
      file: "clouds/puff.particle.json",
      identifier: "test:puff",
      texture: "TEST:CATALOG/LEAF",
      material: "particles_alpha",
      components: [],
      blockbusterComponents: []
    }];
    const result = await listTextures(config, particles, {
      nameContains: "leaf",
      minCoverage: 0.1,
      hasAlpha: true,
      width: 40,
      height: 40,
      usedBy: "puff",
      limit: 10
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      texture: "test:catalog/leaf",
      path: projectEntry.path,
      source: { kind: "project", root: config.resourcePackRoot },
      shadowedSources: [{ kind: "shared_bank", root: bank, bankIndex: 0 }],
      usedBy: [{ file: "clouds/puff.particle.json", identifier: "test:puff" }]
    });
    expect(await listTextures(config, particles, { usedBy: "unknown" })).toEqual([]);
    expect(await listTextures(config, particles, { nameContains: "leaf", minCoverage: 1 })).toEqual([]);
    expect(await listTextures(config, particles, { limit: 1 })).toHaveLength(1);
  });
});

describe("texture generation and import", () => {
  it("persists generated PNGs at the selected bank path with a digest and no overwrite", async () => {
    const { bank, config } = await textureFixture();
    const result = await generateTextureAsset(config, {
      texture: "test:generated/lens",
      primitive: "soft_lens",
      width: 64,
      height: 64,
      seed: 3,
      bank: 0
    });
    const expectedPath = path.join(bank, "test", "generated", "lens.png");
    const bytes = await readFile(expectedPath);
    expect(result.path).toBe(expectedPath);
    expect(result.digest).toBe(sha256(bytes));
    expect(result.source).toEqual({ kind: "shared_bank", root: bank, bankIndex: 0 });
    expect(result.resolution.source).toEqual(result.source);
    expect(result.metrics.brightCoverage).toBeGreaterThanOrEqual(0.35);
    expect(result.note).toMatch(/not proof of Minecraft playback/);
    await expect(generateTextureAsset(config, {
      texture: "test:generated/lens",
      primitive: "puff",
      bank: 0
    })).rejects.toThrow("Refusing to overwrite");
    expect(sha256(await readFile(expectedPath))).toBe(result.digest);
  });

  it("rejects soft_lens below its bright-coverage guard before writing", async () => {
    const { bank, config } = await textureFixture();
    await expect(generateTextureAsset(config, {
      texture: "test:generated/dim",
      primitive: "soft_lens",
      width: 64,
      height: 64,
      intensity: 0.15,
      bank: 0
    })).rejects.toThrow(/bright coverage must be at least 35%/);
    await expect(readFile(path.join(bank, "test", "generated", "dim.png"))).rejects.toThrow();
  });

  it("runs the optional guard after generation and import work but before publishing", async () => {
    const { root, bank, config } = await textureFixture();
    const sourcePath = path.join(root, "guard-source.png");
    await writeFile(sourcePath, png1x1);
    const rejectWrite = () => { throw new Error("configuration changed"); };

    await expect(generateTextureAsset(config, {
      texture: "test:guard/generated",
      primitive: "puff",
      width: 16,
      height: 16,
      bank: 0
    }, rejectWrite)).rejects.toThrow("configuration changed");
    await expect(readFile(path.join(bank, "test", "guard", "generated.png"))).rejects.toThrow();

    await expect(importTextureAsset(config, {
      sourcePath,
      bank: 0,
      name: "test:guard/imported"
    }, rejectWrite)).rejects.toThrow("configuration changed");
    await expect(readFile(path.join(bank, "test", "guard", "imported.png"))).rejects.toThrow();
  });

  it("imports validated PNGs to the exact configured bank and never overwrites", async () => {
    const { root, bank, config } = await textureFixture();
    const sourcePath = path.join(root, "outside.png");
    const source = await generateTexture({ primitive: "ember", width: 32, height: 32, seed: 5 });
    await writeFile(sourcePath, source.bytes);

    const result = await importTextureAsset(config, {
      sourcePath,
      bank,
      name: "custom:imported/ember"
    });
    const expectedPath = path.join(bank, "custom", "imported", "ember.png");
    expect(result.path).toBe(expectedPath);
    expect(result.digest).toBe(sha256(await readFile(expectedPath)));
    expect(result.source).toEqual({ kind: "shared_bank", root: bank, bankIndex: 0 });
    await expect(importTextureAsset(config, { sourcePath, bank: 0, name: "custom:imported/ember" }))
      .rejects.toThrow("Refusing to overwrite");
    await expect(importTextureAsset(config, { sourcePath, bank: path.join(root, "not-configured") }))
      .rejects.toThrow("exactly match");

    const invalidPath = path.join(root, "not-a-png.png");
    await writeFile(invalidPath, Buffer.from("not a png"));
    await expect(importTextureAsset(config, { sourcePath: invalidPath, bank: 0, name: "custom:bad" }))
      .rejects.toThrow("not a valid PNG");
  });
});

describe("flipbook atlas operation", () => {
  it("uses the inspected PNG dimensions to emit the correct UV block", async () => {
    const { config } = await textureFixture();
    const generated = await generateTextureAsset(config, {
      texture: "test:flipbooks/run",
      primitive: "anime_cloud",
      width: 128,
      height: 64
    });
    const result = await textureFlipbookAtlas("test:flipbooks/run", config, {
      columns: 4,
      rows: 2,
      direction: "horizontal",
      startColumn: 1,
      startRow: 1,
      frameCount: 3,
      framesPerSecond: 12
    });

    expect(result.path).toBe(generated.path);
    expect(result.source.kind).toBe("project");
    expect(result.atlas.uv).toEqual({
      texture_width: 128,
      texture_height: 64,
      uv: [32, 32],
      uv_size: [32, 32],
      flipbook: {
        base_UV: [32, 32],
        size_UV: [32, 32],
        step_UV: [32, 0],
        frames_per_second: 12,
        max_frame: 3,
        stretch_to_lifetime: true
      }
    });
  });
});
