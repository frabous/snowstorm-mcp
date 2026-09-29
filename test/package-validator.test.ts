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

  it("accepts recognized gameplay helpers without selectors or custom names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-package-"));
    const config = await projectFixture(root);
    await writeFile(config.selectorsFile, "[]");
    await writeFile(config.spellFile, `main:
  spell-class: .MultiSpell
  spells: [potion, leap, fly, command, teleport]
potion:
  spell-class: .targeted.PotionEffectSpell
leap:
  spell-class: .targeted.LeapSpell
fly:
  spell-class: .instant.FlySpell
command:
  spell-class: .instant.CommandSpell
teleport:
  spell-class: .targeted.TeleportSpell
`);
    const result = await validatePackage(config, new ParticleStore(config), { mainSpell: "main", detail: "full" });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.counts).toMatchObject({ helpers: 5, gameplayHelpers: 5, scheduledLayers: 5 });
    expect(result.layers?.map((layer) => layer.anchor)).toEqual(Array(5).fill("non_emitter"));
    expect(result.layers?.every((layer) => layer.selector === null && layer.file === null)).toBe(true);
  });

  it("keeps emitter helpers blocked when their selector link is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-package-"));
    const config = await projectFixture(root);
    await writeFile(path.join(config.particlesRoot, "test.particle.json"), JSON.stringify(validParticle()));
    await writeFile(config.selectorsFile, JSON.stringify([{ name: "test", type: "*", enabled: true, morph: 'ParticleMorph{Scheme:"test.particle"}' }]));
    await writeFile(config.spellFile, `main:
  spell-class: .MultiSpell
  spells: [emitter]
emitter:
  spell-class: .buff.ArmorStandSpell
  duration: 2
  cancel-on-logout: true
  cancel-on-teleport: true
`);
    const result = await validatePackage(config, new ParticleStore(config), { mainSpell: "main" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "helper-config", message: expect.stringContaining("expected exactly one custom-name") }));
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "selector-helper-missing" }));
  });

  it("blocks unrecognized helper classes even when they have a selector", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-package-"));
    const config = await projectFixture(root);
    await writeFile(path.join(config.particlesRoot, "test.particle.json"), JSON.stringify(validParticle()));
    await writeFile(config.selectorsFile, JSON.stringify([{ name: "test", type: "*", enabled: true, morph: 'ParticleMorph{Scheme:"test.particle"}' }]));
    await writeFile(config.spellFile, `main:
  spell-class: .MultiSpell
  spells: [unknown]
unknown:
  spell-class: .custom.UnknownSpell
  effects:
    - custom-name: test
`);
    const result = await validatePackage(config, new ParticleStore(config), { mainSpell: "main", detail: "full" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "helper-config", message: expect.stringContaining("unrecognized spell-class") }));
    expect(result.layers).toEqual([expect.objectContaining({ helper: "unknown", anchor: "unknown" })]);
  });

  it("reports particle BOMs without unreadable-file cascades and still flags valid orphans", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-package-"));
    const config = await projectFixture(root);
    await writeFile(path.join(config.particlesRoot, "bom.particle.json"), `\uFEFF${JSON.stringify(validParticle())}`);
    await writeFile(path.join(config.particlesRoot, "orphan.particle.json"), JSON.stringify(validParticle("test:orphan")));
    await writeFile(config.selectorsFile, JSON.stringify([
      { name: "bom", type: "*", enabled: true, morph: 'ParticleMorph{Scheme:"bom.particle"}' }
    ]));

    const result = await validatePackage(config, new ParticleStore(config));
    expect(result.errors).toContainEqual(expect.objectContaining({
      code: "bom",
      path: "bom.particle.json",
      message: expect.stringContaining("Remove the BOM")
    }));
    expect(result.errors.some((entry) => entry.code === "particle-json" && entry.message.includes("bom.particle.json"))).toBe(false);
    expect(result.errors.some((entry) => entry.code === "particle-orphan" && entry.message.includes("bom.particle.json"))).toBe(false);
    expect(result.errors.some((entry) => entry.code === "selector-scheme-missing" && entry.message.includes("bom.particle.json"))).toBe(false);
    expect(result.errors.some((entry) => entry.code === "particle-orphan" && entry.message.includes("orphan.particle.json"))).toBe(true);
  });
});
