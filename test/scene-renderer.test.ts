import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ParticleStore } from "../src/particle-store.js";
import { enforceSceneFrameBudget, renderScene } from "../src/scene-renderer.js";
import { renderParticle } from "../src/renderer.js";
import { projectFixture, validParticle } from "./fixtures.js";
import type { JsonObject } from "../src/types.js";

describe("scene render budgets", () => {
  it("allows longer normal-resolution scenes while bounding raster work", () => {
    expect(() => enforceSceneFrameBudget(325, 960, 720)).not.toThrow();
    expect(() => enforceSceneFrameBudget(751, 960, 720)).toThrow("750 frames");
    expect(() => enforceSceneFrameBudget(300, 1920, 1080)).toThrow("rendered-pixel budget");
  });

  it("rejects expression-valued particle counts before launching Chromium", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-scene-"));
    const config = await projectFixture(root);
    const particle = validParticle();
    const components = (particle.particle_effect as JsonObject).components as JsonObject;
    (components["minecraft:emitter_rate_instant"] as JsonObject).num_particles = "1000000";
    await writeFile(path.join(config.particlesRoot, "unsafe.particle.json"), JSON.stringify(particle));
    await expect(renderScene(new ParticleStore(config), config, {
      layers: [{ file: "unsafe.particle.json", startSeconds: 0 }],
      renderStart: 0,
      renderEnd: 1,
      format: "png"
    })).rejects.toThrow("expression-valued num_particles");
  });

  it("applies the same emission budget to single-particle renders", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-render-"));
    const config = await projectFixture(root);
    const particle = validParticle();
    const components = (particle.particle_effect as JsonObject).components as JsonObject;
    (components["minecraft:emitter_rate_instant"] as JsonObject).num_particles = 10_001;
    await writeFile(path.join(config.particlesRoot, "unsafe.particle.json"), JSON.stringify(particle));
    await expect(renderParticle(new ParticleStore(config), config, {
      file: "unsafe.particle.json",
      durationSeconds: 1,
      format: "png"
    })).rejects.toThrow("10,000 particle scene-simulation budget");
  });
});
