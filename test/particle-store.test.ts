import { describe, expect, it } from "vitest";
import path from "node:path";
import { requirePathInside } from "../src/config.js";
import { applyPatch, mergeSnowstormExport, summarizeParticle } from "../src/particle-store.js";
import { resolveTexturePath } from "../src/texture.js";
import { designBrief } from "../src/authoring-guide.js";
import { formatTimecode, parseTimecode } from "../src/video.js";
import type { JsonObject } from "../src/types.js";

const original: JsonObject = {
  format_version: "1.10.0",
  particle_effect: {
    description: {
      identifier: "b.a:test",
      basic_render_parameters: { material: "particles_add", texture: "b.a:particles/test.png" },
      extra_description: "kept"
    },
    components: {
      "minecraft:emitter_rate_instant": { num_particles: 1, extension_value: true },
      "minecraft:particle_motion_dynamic": { linear_acceleration: [0, -1, 0] },
      "blockbuster:particle_morph": { enabled: false },
      "blockbuster:particle_collision_tinting": { enabled: 0 }
    }
  }
};

describe("particle store", () => {
  it("applies narrow RFC 6902 patches", () => {
    const patched = applyPatch(original, [{ op: "replace", path: "/particle_effect/components/minecraft:emitter_rate_instant/num_particles", value: 12 }]);
    const effect = patched.particle_effect as JsonObject;
    const components = effect.components as JsonObject;
    expect((components["minecraft:emitter_rate_instant"] as JsonObject).num_particles).toBe(12);
    expect((original.particle_effect as JsonObject).components).not.toBe(components);
  });

  it("preserves Blockbuster fields when Snowstorm exports a supported edit", () => {
    const generated: JsonObject = {
      format_version: "1.10.0",
      particle_effect: {
        description: {
          identifier: "b.a:test",
          basic_render_parameters: { material: "particles_alpha", texture: "b.a:particles/test.png" }
        },
        components: {
          "minecraft:emitter_rate_instant": { num_particles: 8 },
          "minecraft:particle_motion_parametric": { relative_position: [0, 0, 0] }
        }
      }
    };
    const merged = mergeSnowstormExport(original, generated);
    const effect = merged.particle_effect as JsonObject;
    const components = effect.components as JsonObject;
    expect(components["blockbuster:particle_morph"]).toEqual({ enabled: false });
    expect(components["blockbuster:particle_collision_tinting"]).toEqual({ enabled: 0 });
    expect((components["minecraft:emitter_rate_instant"] as JsonObject).num_particles).toBe(8);
    expect((components["minecraft:emitter_rate_instant"] as JsonObject).extension_value).toBeUndefined();
    expect(components["minecraft:particle_motion_dynamic"]).toBeUndefined();
    expect(components["minecraft:particle_motion_parametric"]).toEqual({ relative_position: [0, 0, 0] });
    expect((effect.description as JsonObject).extra_description).toBe("kept");
  });

  it("summarizes extensions without sending full JSON", () => {
    const summary = summarizeParticle(original, "test.particle.json");
    expect(summary.identifier).toBe("b.a:test");
    expect(summary.blockbusterComponents).toEqual([
      "blockbuster:particle_collision_tinting",
      "blockbuster:particle_morph"
    ]);
  });

  it("refuses paths outside the configured root", () => {
    expect(() => requirePathInside("C:\\project\\particles", "..\\secrets.json")).toThrow("escapes");
    expect(requirePathInside("C:\\project\\particles", "a\\effect.particle.json")).toBe("C:\\project\\particles\\a\\effect.particle.json");
  });

  it("rejects texture traversal before a renderer can read it", () => {
    const config = {
      resourcePackRoot: process.cwd()
    } as never;
    expect(resolveTexturePath("b.a:particles/megumin/spark", config)).toBe(path.join(process.cwd(), "assets", "b.a", "textures", "particles", "megumin", "spark.png"));
    expect(() => resolveTexturePath("b.a:../../secret", config)).toThrow("unsafe");
    expect(() => resolveTexturePath("b.a:particles\\secret", config)).toThrow("unsafe");
  });

  it("returns a reusable Blockbuster design brief", () => {
    expect(designBrief("trail", 1.5, true)).toMatchObject({ recommendedTemplate: "trail", motion: "parametric", localSpace: true, durationSeconds: 1.5 });
  });

  it("parses and formats millisecond-precise video timecodes", () => {
    expect(parseTimecode("00:01:02.375")).toBe(62.375);
    expect(parseTimecode(0.5)).toBe(0.5);
    expect(formatTimecode(62.375)).toBe("00:01:02.375");
    expect(() => parseTimecode("1:61:00")).toThrow("Invalid");
  });
});
