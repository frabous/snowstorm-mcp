import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ParticleStore } from "../src/particle-store.js";
import { cameraForTime, deriveSampleTimes, enforceRenderBudget, enforceSceneFrameBudget, renderScene, type SceneShot } from "../src/scene-renderer.js";
import { particleTiming } from "../src/validator.js";
import { renderParticle } from "../src/renderer.js";
import { projectFixture, validParticle } from "./fixtures.js";
import type { JsonObject } from "../src/types.js";

describe("scene camera shots", () => {
  const near = { position: [2, 2, 2] as [number, number, number], target: [0, 0, 0] as [number, number, number] };
  const far = { position: [40, 20, 40] as [number, number, number], target: [0, 2, 0] as [number, number, number] };
  const shots: SceneShot[] = [
    { startSeconds: 10, endSeconds: 14, camera: near },
    { startSeconds: 14, endSeconds: 18, camera: far }
  ];

  it("selects the shot covering each time and falls back outside every shot", () => {
    expect(cameraForTime(shots, 10, far)).toBe(near);
    expect(cameraForTime(shots, 13.99, far)).toBe(near);
    expect(cameraForTime(shots, 14, far)).toBe(far);
    expect(cameraForTime(shots, 20, far)).toBe(far);
    expect(cameraForTime(shots, 5, far)).toBe(far);
    expect(cameraForTime(undefined, 12, far)).toBe(far);
  });
});

describe("derived sample times", () => {
  it("samples each layer at its own start, midpoint and tail", () => {
    const times = deriveSampleTimes([
      { startSeconds: 10, lifetime: 6.4 },
      { startSeconds: 10.1, lifetime: 7.2 }
    ], 10, 17.3);
    expect(times[0]).toBe(10);
    expect(times.at(-1)).toBe(17.3);
    expect(times).toContain(13.2);
    expect(times).toContain(15.76);
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(new Set(times).size).toBe(times.length);
  });

  it("stays inside the window and honours the sheet limit", () => {
    const layers = Array.from({ length: 20 }, (_, index) => ({ startSeconds: index / 4, lifetime: 3 }));
    const times = deriveSampleTimes(layers, 0, 30);
    expect(times.length).toBeLessThanOrEqual(24);
    expect(times.every((time) => time >= 0 && time <= 30)).toBe(true);
  });
});

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
    (components["minecraft:emitter_rate_instant"] as JsonObject).num_particles = "math.sin(variable.emitter_age)";
    await writeFile(path.join(config.particlesRoot, "unsafe.particle.json"), JSON.stringify(particle));
    await expect(renderScene(new ParticleStore(config), config, {
      layers: [{ file: "unsafe.particle.json", startSeconds: 0 }],
      renderStart: 0,
      renderEnd: 1,
      format: "png"
    })).rejects.toThrow("expression-valued num_particles");
  });

  it("bounds a rate that a client downgraded to a bare numeric string", () => {
    const particle = validParticle();
    const components = (particle.particle_effect as JsonObject).components as JsonObject;
    delete (components["minecraft:emitter_rate_instant"] as JsonObject).num_particles;
    components["minecraft:emitter_rate_steady"] = { spawn_rate: "4", max_particles: "120" };
    expect(enforceRenderBudget(particle, "quoted.particle.json", 2)).toBe(120);
  });

  it("still refuses a rate that is neither a number nor a bare numeric string", () => {
    const particle = validParticle();
    const components = (particle.particle_effect as JsonObject).components as JsonObject;
    (components["minecraft:emitter_rate_instant"] as JsonObject).num_particles = "math.sin(variable.emitter_age)";
    expect(() => enforceRenderBudget(particle, "quoted.particle.json", 1)).toThrow("expression-valued num_particles");
  });

  it("enforces the particle budget on a downgraded numeric string", () => {
    const particle = validParticle();
    const components = (particle.particle_effect as JsonObject).components as JsonObject;
    (components["minecraft:emitter_rate_instant"] as JsonObject).num_particles = "10001";
    expect(() => enforceRenderBudget(particle, "quoted.particle.json", 1)).toThrow("10,000 particle scene-simulation budget");
  });

  it("reads a bare numeric string as a finite lifetime for scene verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-scene-"));
    const config = await projectFixture(root);
    const particle = validParticle();
    const components = (particle.particle_effect as JsonObject).components as JsonObject;
    (components["minecraft:emitter_lifetime_once"] as JsonObject).active_time = "0.1";
    (components["minecraft:particle_lifetime_expression"] as JsonObject).max_lifetime = "1";
    expect(particleTiming(particle)).toEqual({ emitterSeconds: 0.1, particleSeconds: 1 });
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
