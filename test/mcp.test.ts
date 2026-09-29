import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import { ParticleStore } from "../src/particle-store.js";
import { projectFixture, validParticle } from "./fixtures.js";

interface RegisteredTool {
  handler(args: Record<string, unknown>): Promise<{ content: Array<{ text?: string }> }>;
}

interface McpTestServer {
  _registeredTools: Record<string, RegisteredTool>;
  toolInputSchemaJson(name: string): unknown;
}

const expectedToolNames = [
  "flipbook_atlas",
  "particle_authoring_guide",
  "particle_create",
  "particle_design_brief",
  "particle_inspect",
  "particle_list",
  "particle_open_desktop",
  "particle_patch",
  "particle_patch_batch",
  "particle_probe",
  "particle_query",
  "particle_render",
  "particle_render_scene",
  "particle_validate",
  "particle_verify_package",
  "project_list",
  "project_use",
  "selectors_merge",
  "spell_retime",
  "spell_timeline_inspect",
  "texture_contact_sheet",
  "texture_generate",
  "texture_import",
  "texture_list",
  "video_analyze",
  "video_audio_transients",
  "video_compare",
  "video_extract_frames",
  "video_import",
  "video_list"
];

describe("MCP registration", () => {
  it("registers the 28 existing tools and the two project tools with input schemas", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-mcp-"));
    await projectFixture(root);
    const configPath = path.join(root, "snowstorm-mcp.config.json");
    await writeFile(configPath, JSON.stringify({
      projectName: "mcp-test",
      particlesRoot: "./particles",
      resourcePackRoot: "./resource-pack",
      selectorsFile: "./selectors.json",
      spellFile: "./spells.yml",
      artifactsRoot: "./artifacts"
    }, null, 2));

    const server = await createMcpServer(configPath);
    const sdk = server as unknown as McpTestServer;
    expect(Object.keys(sdk._registeredTools).sort()).toEqual(expectedToolNames);
    expect(expectedToolNames).toHaveLength(30);
    for (const name of expectedToolNames) {
      expect(sdk.toolInputSchemaJson(name), `${name} should expose its registered input schema`).toBeDefined();
    }

    const videoImportSchema = sdk.toolInputSchemaJson("video_import") as {
      properties: { sourcePath: { maxLength?: number } };
    };
    expect(videoImportSchema.properties.sourcePath.maxLength).toBe(512);
    const projectUseSchema = sdk.toolInputSchemaJson("project_use") as {
      properties: { name: { minLength?: number; maxLength?: number } };
    };
    expect(projectUseSchema.properties.name).toMatchObject({ minLength: 1, maxLength: 128 });
  });

  it("routes later particle and video calls through the selected project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-mcp-"));
    const alpha = await projectFixture(path.join(root, "alpha"));
    const beta = await projectFixture(path.join(root, "beta"));
    await writeFile(path.join(alpha.particlesRoot, "alpha.particle.json"), JSON.stringify(validParticle("alpha:effect")));
    await writeFile(path.join(beta.particlesRoot, "beta.particle.json"), JSON.stringify(validParticle("beta:effect")));

    const configPath = path.join(root, "registry.json");
    const project = (name: string) => ({
      projectName: `${name}-project`,
      particlesRoot: `./${name}/particles`,
      resourcePackRoot: `./${name}/resource-pack`,
      selectorsFile: `./${name}/selectors.json`,
      spellFile: `./${name}/spells.yml`,
      referenceVideosRoot: `./${name}/reference-videos`,
      artifactsRoot: `./${name}/artifacts`
    });
    await writeFile(configPath, JSON.stringify({
      activeProject: "beta",
      projects: { alpha: project("alpha"), beta: project("beta") }
    }, null, 2));

    const server = await createMcpServer(configPath);
    const sdk = server as unknown as McpTestServer;
    const switched = await sdk._registeredTools.project_use.handler({ name: "alpha" });
    expect(JSON.parse(switched.content[0].text!)).toMatchObject({
      activeProject: "alpha",
      projectName: "alpha-project",
      particlesRoot: alpha.particlesRoot
    });

    const particles = await sdk._registeredTools.particle_list.handler({});
    expect(JSON.parse(particles.content[0].text!).map((particle: { file: string }) => particle.file)).toEqual(["alpha.particle.json"]);
    const videos = await sdk._registeredTools.video_list.handler({});
    expect(JSON.parse(videos.content[0].text!).root).toBe(path.join(root, "alpha", "reference-videos"));
  });

  it("waits for an in-flight particle_create before switching projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-mcp-"));
    const alpha = await projectFixture(path.join(root, "alpha"));
    const beta = await projectFixture(path.join(root, "beta"));
    const configPath = path.join(root, "registry.json");
    const project = (name: string) => ({
      projectName: `${name}-project`,
      particlesRoot: `./${name}/particles`,
      resourcePackRoot: `./${name}/resource-pack`,
      selectorsFile: `./${name}/selectors.json`,
      spellFile: `./${name}/spells.yml`,
      referenceVideosRoot: `./${name}/reference-videos`,
      artifactsRoot: `./${name}/artifacts`
    });
    await writeFile(configPath, JSON.stringify({
      activeProject: "alpha",
      projects: { alpha: project("alpha"), beta: project("beta") }
    }, null, 2));

    const server = await createMcpServer(configPath);
    const sdk = server as unknown as McpTestServer;
    let releaseExists!: () => void;
    let enteredFirstExists!: () => void;
    let enteredBothExists!: () => void;
    const heldExists = new Promise<void>((resolve) => { releaseExists = resolve; });
    const firstExistsEntered = new Promise<void>((resolve) => { enteredFirstExists = resolve; });
    const bothExistsEntered = new Promise<void>((resolve) => { enteredBothExists = resolve; });
    let pausedExistsCount = 0;
    const originalExists = ParticleStore.prototype.exists;
    ParticleStore.prototype.exists = async function (file) {
      if (file === "overlap.particle.json" || file === "parallel.particle.json") {
        pausedExistsCount += 1;
        if (pausedExistsCount === 1) enteredFirstExists();
        if (pausedExistsCount === 2) enteredBothExists();
        await heldExists;
        return false;
      }
      return originalExists.call(this, file);
    };

    try {
      const createPromise = sdk._registeredTools.particle_create.handler({
        file: "overlap.particle.json",
        document: validParticle("test:overlap"),
        dryRun: false
      });
      await firstExistsEntered;
      const parallelCreatePromise = sdk._registeredTools.particle_create.handler({
        file: "parallel.particle.json",
        document: validParticle("test:parallel"),
        dryRun: false
      });
      await bothExistsEntered;

      let switchCompleted = false;
      const switchPromise = sdk._registeredTools.project_use.handler({ name: "beta" }).then((result) => {
        switchCompleted = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(switchCompleted).toBe(false);

      releaseExists();
      const [created, parallelCreated, switched] = await Promise.all([createPromise, parallelCreatePromise, switchPromise]);
      expect(JSON.parse(created.content[0].text!)).toMatchObject({ created: true });
      expect(JSON.parse(parallelCreated.content[0].text!)).toMatchObject({ created: true });
      expect(JSON.parse(switched.content[0].text!)).toMatchObject({ activeProject: "beta" });
      expect(await readFile(path.join(alpha.particlesRoot, "overlap.particle.json"), "utf8")).toContain("test:overlap");
      await expect(readFile(path.join(beta.particlesRoot, "overlap.particle.json"))).rejects.toThrow();
      expect(await readFile(path.join(alpha.particlesRoot, "parallel.particle.json"), "utf8")).toContain("test:parallel");
      await expect(readFile(path.join(beta.particlesRoot, "parallel.particle.json"))).rejects.toThrow();
    } finally {
      releaseExists();
      ParticleStore.prototype.exists = originalExists;
    }
  });
});
