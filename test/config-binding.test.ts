import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertConfigCurrent, loadConfig, ProjectRegistry } from "../src/config.js";
import { ParticleStore } from "../src/particle-store.js";
import { projectFixture } from "./fixtures.js";

async function configOnDisk(root: string) {
  await projectFixture(root);
  const configPath = path.join(root, "snowstorm-mcp.config.json");
  const body = (projectName: string) => JSON.stringify({
    projectName,
    particlesRoot: "./particles",
    resourcePackRoot: "./resource-pack",
    selectorsFile: "./selectors.json",
    spellFile: "./spells.yml",
    artifactsRoot: "./artifacts"
  }, null, 2);
  await writeFile(configPath, body("first-project"));
  return configPath;
}

async function registryOnDisk(root: string, sharedTextureBanks?: string[]) {
  await projectFixture(path.join(root, "alpha"));
  await projectFixture(path.join(root, "beta"));
  const configPath = path.join(root, "registry.json");
  const project = (name: string) => ({
    projectName: `${name}-project`,
    particlesRoot: `./${name}/particles`,
    resourcePackRoot: `./${name}/resource-pack`,
    selectorsFile: `./${name}/selectors.json`,
    spellFile: `./${name}/spells.yml`,
    artifactsRoot: `./${name}/artifacts`
  });
  await writeFile(configPath, JSON.stringify({
    activeProject: "beta",
    projects: { alpha: project("alpha"), beta: project("beta") },
    ...(sharedTextureBanks === undefined ? {} : { sharedTextureBanks })
  }, null, 2));
  return configPath;
}

describe("configuration binding", () => {
  it("defaults to no shared texture banks when omitted from a flat config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const config = await loadConfig(await configOnDisk(root));
    expect(config.sharedTextureBanks).toEqual([]);
  });

  it("keeps a legacy flat config as one implicit project named by projectName", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const registry = await ProjectRegistry.load(await configOnDisk(root));
    expect(registry.list()).toEqual(["first-project"]);
    expect(registry.activeProject).toBe("first-project");
  });

  it("uses a stable default key when a legacy config omits projectName", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const configPath = await configOnDisk(root);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    delete raw.projectName;
    await writeFile(configPath, JSON.stringify(raw, null, 2));

    const registry = await ProjectRegistry.load(configPath);
    expect(registry.list()).toEqual(["default"]);
    expect(registry.currentConfig.projectName).toBe("snowstorm-project");
  });

  it("lists registry projects and switches active values without reloading the process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const configPath = await registryOnDisk(root, ["./shared/textures"]);
    const registry = await ProjectRegistry.load(configPath);

    expect(registry.list()).toEqual(["alpha", "beta"]);
    expect(registry.activeProject).toBe("beta");
    expect(registry.currentConfig.projectName).toBe("beta-project");
    expect(registry.currentConfig.particlesRoot).toBe(path.join(root, "beta", "particles"));
    expect(registry.currentConfig.sharedTextureBanks).toEqual([path.join(root, "shared", "textures")]);

    const alphaConfig = await registry.use("alpha");
    expect(registry.activeProject).toBe("alpha");
    expect(alphaConfig.projectName).toBe("alpha-project");
    expect(alphaConfig.particlesRoot).toBe(path.join(root, "alpha", "particles"));
    expect(alphaConfig.sharedTextureBanks).toEqual([path.join(root, "shared", "textures")]);
  });

  it("defaults to the first project key and tolerates project-key reordering", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const configPath = await registryOnDisk(root);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const projects = raw.projects as Record<string, Record<string, unknown>>;
    delete raw.activeProject;
    raw.projects = Object.fromEntries(Object.entries(projects).reverse());
    await writeFile(configPath, JSON.stringify(raw, null, 2));

    const registry = await ProjectRegistry.load(configPath);
    expect(registry.activeProject).toBe("alpha");
    expect(registry.currentConfig.projectName).toBe("alpha-project");

    raw.projects = Object.fromEntries(Object.entries(raw.projects as Record<string, Record<string, unknown>>).reverse());
    await writeFile(configPath, JSON.stringify(raw, null, 2));
    expect(() => registry.assertCurrent()).not.toThrow();
    expect((await ProjectRegistry.load(configPath)).activeProject).toBe("alpha");
  });

  it.each([
    { value: "", message: "non-blank string" },
    { value: "   ", message: "non-blank string" },
    { value: 42, message: "non-blank string" },
    { value: null, message: "non-blank string" },
    { value: "not-configured", message: "not defined" }
  ])("rejects invalid activeProject value $value", async ({ value, message }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const configPath = await registryOnDisk(root);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    raw.activeProject = value;
    await writeFile(configPath, JSON.stringify(raw, null, 2));

    await expect(ProjectRegistry.load(configPath)).rejects.toThrow(message);
  });

  it("defaults omitted registry banks to none for every selected project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const registry = await ProjectRegistry.load(await registryOnDisk(root));
    expect(registry.currentConfig.sharedTextureBanks).toEqual([]);
    expect((await registry.use("alpha")).sharedTextureBanks).toEqual([]);
  });

  it("allows an explicit empty shared texture bank list", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const configPath = await registryOnDisk(root, []);
    expect((await loadConfig(configPath)).sharedTextureBanks).toEqual([]);
  });

  it("stays silent while the configuration file is unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const config = await loadConfig(await configOnDisk(root));
    expect(config.configDigest).toBeTruthy();
    expect(config.sharedTextureBanks).toEqual([]);
    expect(() => assertConfigCurrent(config)).not.toThrow();
  });

  it("resolves optional shared banks relative to the config without creating them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const configPath = await configOnDisk(root);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    raw.sharedTextureBanks = ["../library/textures"];
    await writeFile(configPath, JSON.stringify(raw, null, 2));

    const config = await loadConfig(configPath);
    const expectedBank = path.resolve(path.dirname(configPath), "../library/textures");
    expect(config.sharedTextureBanks).toEqual([expectedBank]);
    expect(existsSync(expectedBank)).toBe(false);
  });

  it("names the restart and the stale project once the configuration changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const configPath = await configOnDisk(root);
    const config = await loadConfig(configPath);
    await writeFile(configPath, JSON.stringify({ projectName: "second-project" }, null, 2));
    expect(() => assertConfigCurrent(config)).toThrow("changed on disk");
    expect(() => assertConfigCurrent(config)).toThrow("first-project");
    expect(() => assertConfigCurrent(config)).toThrow("Restart the MCP server");
  });

  it("does not require restart for an activeProject-only edit, but does for changed definitions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const configPath = await registryOnDisk(root);
    const registry = await ProjectRegistry.load(configPath);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    raw.activeProject = "alpha";
    await writeFile(configPath, JSON.stringify(raw, null, 2));
    expect(() => registry.assertCurrent()).not.toThrow();
    delete raw.activeProject;
    await writeFile(configPath, JSON.stringify(raw, null, 2));
    expect(() => registry.assertCurrent()).not.toThrow();

    const projects = raw.projects as Record<string, Record<string, unknown>>;
    projects.alpha.particlesRoot = "./changed/particles";
    await writeFile(configPath, JSON.stringify(raw, null, 2));
    expect(() => registry.assertCurrent()).toThrow("Project definitions changed");
    expect(() => registry.assertCurrent()).toThrow("Restart the MCP server");
  });

  it("surfaces the restart requirement on the particle path that produced the confusing ENOENT", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const configPath = await configOnDisk(root);
    const config = await loadConfig(configPath);
    const store = new ParticleStore(config);
    expect(store.resolve("known.particle.json")).toBe(path.join(config.particlesRoot, "known.particle.json"));
    await writeFile(configPath, JSON.stringify({ projectName: "second-project" }, null, 2));
    expect(() => store.resolve("known.particle.json")).toThrow("Restart the MCP server");
  });

  it("names the bound project on a traversal refusal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const config = await loadConfig(await configOnDisk(root));
    const store = new ParticleStore(config);
    expect(() => store.resolve("../secrets.particle.json")).toThrow("bound to project 'first-project'");
  });
});
