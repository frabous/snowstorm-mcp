import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonObject, ProjectConfig } from "../src/types.js";

export const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACa1n4QAAAABJRU5ErkJggg==", "base64");

export function validParticle(identifier = "test:effect"): JsonObject {
  return {
    format_version: "1.10.0",
    particle_effect: {
      description: {
        identifier,
        basic_render_parameters: { material: "particles_alpha", texture: "test:particles/test" }
      },
      components: {
        "minecraft:emitter_rate_instant": { num_particles: 2 },
        "minecraft:emitter_lifetime_once": { active_time: 0.1 },
        "minecraft:particle_lifetime_expression": { max_lifetime: 1 },
        "minecraft:particle_appearance_billboard": {
          size: [1, 1],
          facing_camera_mode: "lookat_xyz",
          uv: { texture_width: 1, texture_height: 1, uv: [0, 0], uv_size: [1, 1] }
        },
        "minecraft:particle_motion_dynamic": { linear_acceleration: [0, 0, 0] }
      }
    }
  };
}

export async function projectFixture(root: string): Promise<ProjectConfig> {
  const particlesRoot = path.join(root, "particles");
  const resourcePackRoot = path.join(root, "resource-pack");
  const artifactsRoot = path.join(root, "artifacts");
  const selectorsFile = path.join(root, "selectors.json");
  const spellFile = path.join(root, "spells.yml");
  await Promise.all([
    mkdir(particlesRoot, { recursive: true }),
    mkdir(path.join(resourcePackRoot, "assets", "test", "textures", "particles"), { recursive: true }),
    mkdir(artifactsRoot, { recursive: true })
  ]);
  await writeFile(path.join(resourcePackRoot, "assets", "test", "textures", "particles", "test.png"), png1x1);
  await writeFile(selectorsFile, "{}\n");
  await writeFile(spellFile, "{}\n");
  return {
    configPath: path.join(root, "snowstorm-mcp.config.json"),
    projectName: "test",
    particlesRoot,
    resourcePackRoot,
    selectorsFile,
    spellFile,
    referenceVideosRoot: path.join(artifactsRoot, "reference-videos"),
    artifactsRoot
  };
}
