import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateParticle } from "../src/validator.js";
import { projectFixture, validParticle } from "./fixtures.js";
import type { JsonObject } from "../src/types.js";

describe("particle validation", () => {
  it("accepts a finite supported particle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-validator-"));
    const config = await projectFixture(root);
    const result = await validateParticle(validParticle(), config, "test.particle.json");
    expect(result.valid).toBe(true);
    expect(result.texture).toMatchObject({ width: 1, height: 1, hasAlphaChannel: true });
  });

  it("rejects unsupported materials and non-positive lifetimes", async () => {
    const particle = validParticle();
    const effect = particle.particle_effect as JsonObject;
    const description = effect.description as JsonObject;
    (description.basic_render_parameters as JsonObject).material = "unsupported";
    const components = effect.components as JsonObject;
    (components["minecraft:particle_lifetime_expression"] as JsonObject).max_lifetime = 0;
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-validator-"));
    const config = await projectFixture(root);
    const result = await validateParticle(particle, config, "test.particle.json");
    expect(result.issues.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "/particle_effect/description/basic_render_parameters/material",
      "/particle_effect/components/minecraft:particle_lifetime_expression/max_lifetime"
    ]));
  });

  it("checks UV bounds against the actual PNG", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-validator-"));
    const config = await projectFixture(root);
    const particle = validParticle();
    const components = ((particle.particle_effect as JsonObject).components as JsonObject);
    const billboard = components["minecraft:particle_appearance_billboard"] as JsonObject;
    (billboard.uv as JsonObject).uv_size = [2, 1];
    const result = await validateParticle(particle, config, "test.particle.json");
    expect(result.issues.some((entry) => entry.code === "uv-bounds")).toBe(true);
  });

  it("rejects texture addresses without namespace syntax", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-validator-"));
    const config = await projectFixture(root);
    const particle = validParticle();
    const description = ((particle.particle_effect as JsonObject).description as JsonObject);
    (description.basic_render_parameters as JsonObject).texture = "missing";
    const result = await validateParticle(particle, config, "test.particle.json");
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "error", code: "texture" }));
  });
});
