import { describe, expect, it } from "vitest";
import {
  BRIGHT_COVERAGE_THRESHOLD,
  createFlipbookAtlas,
  flipbook_atlas,
  generateTexture,
  MIN_SOFT_LENS_BRIGHT_COVERAGE,
  TEXTURE_PRIMITIVES
} from "../src/texture-generator.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe("texture generation", () => {
  it.each(TEXTURE_PRIMITIVES)("generates a valid measured PNG for %s", async (primitive) => {
    const generated = await generateTexture({ primitive, width: 64, height: 64, seed: 73 });

    expect(generated.bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(generated.bytes.toString("ascii", 12, 16)).toBe("IHDR");
    expect(generated.bytes.readUInt32BE(16)).toBe(64);
    expect(generated.bytes.readUInt32BE(20)).toBe(64);
    expect(generated.bytes.length).toBeGreaterThan(64);
    expect(generated.width).toBe(64);
    expect(generated.height).toBe(64);
    expect(generated.alphaCoverage).toBeGreaterThan(0);
    expect(generated.alphaCoverage).toBeLessThanOrEqual(1);
    expect(generated.brightCoverage).toBeGreaterThanOrEqual(0);
    expect(generated.brightCoverage).toBeLessThanOrEqual(1);
    expect(generated.hasAlpha).toBe(true);
  });

  it("keeps the soft lens bright over at least 35% of the frame", async () => {
    const generated = await generateTexture({ primitive: "soft_lens", width: 96, height: 96, seed: 1 });

    expect(generated.brightCoverage).toBeGreaterThanOrEqual(MIN_SOFT_LENS_BRIGHT_COVERAGE);
    expect(generated.alphaCoverage).toBeGreaterThan(generated.brightCoverage);
    expect(BRIGHT_COVERAGE_THRESHOLD).toBe(0.1);
    await expect(generateTexture({ primitive: "soft_lens", width: 96, height: 96, intensity: 0.15 }))
      .rejects.toThrow(/bright coverage must be at least 35%/);
  });

  it("produces identical PNG bytes for repeated generation with the same seed", async () => {
    const options = { primitive: "anime_cloud" as const, width: 72, height: 72, seed: 123456 };
    const first = await generateTexture(options);
    const second = await generateTexture(options);

    expect(second.bytes).toEqual(first.bytes);
    expect(second.alphaCoverage).toBe(first.alphaCoverage);
    expect(second.brightCoverage).toBe(first.brightCoverage);
  });

  it("rejects invalid dimensions and generation parameters", async () => {
    await expect(generateTexture({ primitive: "puff", width: 0 })).rejects.toThrow("width must be an integer");
    await expect(generateTexture({ primitive: "puff", width: 4.5 })).rejects.toThrow("width must be an integer");
    await expect(generateTexture({ primitive: "ember", width: 8_192, height: 8_192 })).rejects.toThrow("pixel limit");
    await expect(generateTexture({ primitive: "streak", intensity: 0 })).rejects.toThrow("intensity");
    await expect(generateTexture({ primitive: "streak", tint: "red" })).rejects.toThrow("six-digit hex");
    await expect(generateTexture({ primitive: "lightning", seed: -1 })).rejects.toThrow("unsigned 32-bit");
  });
});

describe("flipbook atlas helper", () => {
  it("calculates UV and flipbook values from the supplied image dimensions", () => {
    const atlas = createFlipbookAtlas(128, 64, {
      columns: 4,
      rows: 2,
      direction: "horizontal",
      startColumn: 1,
      startRow: 1,
      frameCount: 3,
      framesPerSecond: 12
    });

    expect(atlas.imageWidth).toBe(128);
    expect(atlas.imageHeight).toBe(64);
    expect(atlas.frameWidth).toBe(32);
    expect(atlas.frameHeight).toBe(32);
    expect(atlas.frames).toHaveLength(8);
    expect(atlas.frames[7]).toEqual({ index: 7, column: 3, row: 1, uv: [96, 32], uvSize: [32, 32] });
    expect(atlas.uv).toEqual({
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

  it("supports a vertical strip and the plan-named alias", () => {
    const atlas = flipbook_atlas(32, 96, { columns: 1, rows: 3, direction: "vertical" });

    expect(atlas.uv.flipbook.step_UV).toEqual([0, 32]);
    expect(atlas.uv.flipbook.max_frame).toBe(3);
    expect(atlas.uv.texture_height).toBe(96);
  });

  it("rejects invalid image dimensions, grids, and frame ranges", () => {
    expect(() => createFlipbookAtlas(0, 64, { columns: 1, rows: 1 })).toThrow("imageWidth must be an integer");
    expect(() => createFlipbookAtlas(100, 64, { columns: 3, rows: 2 })).toThrow("divide evenly");
    expect(() => createFlipbookAtlas(64, 64, { columns: 0, rows: 2 })).toThrow("positive integers");
    expect(() => createFlipbookAtlas(64, 64, { columns: 4, rows: 4, direction: "horizontal", frameCount: 5 })).toThrow("frameCount");
    expect(() => createFlipbookAtlas(64, 64, { columns: 4, rows: 4, framesPerSecond: Number.NaN })).toThrow("framesPerSecond");
    expect(() => createFlipbookAtlas(8_192, 2_048, { columns: 8_192, rows: 2_048 })).toThrow("frame limit");
    expect(() => createFlipbookAtlas(64, 64, { columns: 1, rows: 1, stretchToLifetime: "yes" as never })).toThrow("stretchToLifetime");
  });
});
