import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ParticleStore } from "../src/particle-store.js";
import { validatePackage } from "../src/package-validator.js";
import { projectFixture, validParticle } from "./fixtures.js";

describe("package graph validation", () => {
  it("joins particles, selectors, helpers and cumulative timing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-package-"));
    const config = await projectFixture(root);
    await writeFile(path.join(config.particlesRoot, "test.particle.json"), JSON.stringify(validParticle()));
    await writeFile(config.selectorsFile, JSON.stringify([{ name: "test", type: "*", enabled: true, morph: 'ParticleMorph{Scheme:"test.particle"}' }]));
    await writeFile(config.spellFile, `main:
  spell-class: .MultiSpell
  spells:
    - helper
helper:
  spell-class: .buff.ArmorStandSpell
  duration: 2
  cancel-on-logout: true
  cancel-on-teleport: true
  effects:
    - custom-name: test
`);
    const result = await validatePackage(config, new ParticleStore(config), { mainSpell: "main", detail: "full" });
    expect(result.valid).toBe(true);
    expect(result.counts).toMatchObject({ particles: 1, selectors: 1, helpers: 1, scheduledLayers: 1 });
    expect(result.layers).toEqual([expect.objectContaining({ helper: "helper", selector: "test", file: "test.particle.json", startSeconds: 0 })]);
  });

  it("reports duplicate selector textures and helpers too short for their particles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-package-"));
    const config = await projectFixture(root);
    await writeFile(path.join(config.particlesRoot, "test.particle.json"), JSON.stringify(validParticle()));
    await writeFile(config.selectorsFile, JSON.stringify([
      { name: "test", type: "*", enabled: true, morph: 'ParticleMorph{Scheme:"test.particle"}' },
      { name: "duplicate", type: "*", enabled: true, morph: 'ParticleMorph{Scheme:"test.particle"}' }
    ]));
    await writeFile(config.spellFile, `main:
  spell-class: .MultiSpell
  spells: [helper]
helper:
  spell-class: .buff.ArmorStandSpell
  duration: 0.05
  cancel-on-logout: true
  cancel-on-teleport: true
  effects:
    - custom-name: test
`);
    const result = await validatePackage(config, new ParticleStore(config), { mainSpell: "main" });
    expect(result.valid).toBe(false);
    expect(result.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining(["selector-scheme-duplicate", "helper-duration"]));
  });

  it("returns structured errors for missing helpers and cyclic YAML aliases", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-package-"));
    const config = await projectFixture(root);
    await writeFile(path.join(config.particlesRoot, "test.particle.json"), JSON.stringify(validParticle()));
    await writeFile(config.selectorsFile, JSON.stringify([{ name: "test", type: "*", enabled: true, morph: 'ParticleMorph{Scheme:"test.particle"}' }]));
    await writeFile(config.spellFile, `main:
  spell-class: .MultiSpell
  spells: [missing]
helper: &helper
  spell-class: .buff.ArmorStandSpell
  custom-name: test
  duration: 2
  cancel-on-logout: true
  cancel-on-teleport: true
  nested: *helper
`);
    const missing = await validatePackage(config, new ParticleStore(config), { mainSpell: "main" });
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContainEqual(expect.objectContaining({ code: "helper-missing" }));
    await writeFile(config.spellFile, (await readFile(config.spellFile, "utf8")).replace("spells: [missing]", "spells: [helper]"));
    const cyclic = await validatePackage(config, new ParticleStore(config), { mainSpell: "main" });
    expect(cyclic.valid).toBe(false);
    expect(cyclic.errors).toContainEqual(expect.objectContaining({ code: "helper-config", message: expect.stringContaining("cyclic") }));
  });
});
