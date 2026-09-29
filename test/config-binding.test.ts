import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertConfigCurrent, loadConfig } from "../src/config.js";
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

describe("configuration binding", () => {
  it("stays silent while the configuration file is unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-config-"));
    const config = await loadConfig(await configOnDisk(root));
    expect(config.configDigest).toBeTruthy();
    expect(() => assertConfigCurrent(config)).not.toThrow();
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
