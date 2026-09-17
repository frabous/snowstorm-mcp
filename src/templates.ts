import type { JsonObject } from "./types.js";

export const templateNames = ["burst", "aura", "trail", "shockwave", "smoke"] as const;
export type TemplateName = (typeof templateNames)[number];

export function createTemplate(template: TemplateName, identifier: string, texture: string): JsonObject {
  const base: JsonObject = {
    format_version: "1.10.0",
    particle_effect: {
      description: {
        identifier,
        basic_render_parameters: { material: "particles_add", texture }
      },
      components: {
        "minecraft:emitter_shape_point": { offset: [0, 0, 0] },
        "minecraft:particle_lifetime_expression": { max_lifetime: 0.8 },
        "minecraft:particle_appearance_billboard": {
          size: [0.35, 0.35],
          facing_camera_mode: "rotate_xyz"
        }
      }
    }
  };
  const components = (base.particle_effect as JsonObject).components as JsonObject;

  if (template === "burst") {
    components["minecraft:emitter_rate_instant"] = { num_particles: 24 };
    components["minecraft:emitter_lifetime_once"] = { active_time: 0.1 };
    components["minecraft:particle_initial_speed"] = 3;
    components["minecraft:particle_motion_dynamic"] = { linear_acceleration: [0, -3, 0], linear_drag_coefficient: 0.5 };
  } else if (template === "aura") {
    components["minecraft:emitter_rate_steady"] = { spawn_rate: 12, max_particles: 16 };
    components["minecraft:emitter_lifetime_looping"] = { active_time: 1, sleep_time: 0 };
    components["minecraft:emitter_shape_sphere"] = { radius: 0.5, surface_only: true };
    components["minecraft:emitter_local_space"] = { position: true, rotation: true };
  } else if (template === "trail") {
    components["minecraft:emitter_rate_steady"] = { spawn_rate: 24, max_particles: 30 };
    components["minecraft:emitter_lifetime_once"] = { active_time: 1.2 };
    components["minecraft:particle_initial_speed"] = 0;
    components["minecraft:particle_motion_parametric"] = { relative_position: ["variable.particle_age * 2", 0, 0] };
  } else if (template === "shockwave") {
    components["minecraft:emitter_rate_instant"] = { num_particles: 1 };
    components["minecraft:emitter_lifetime_once"] = { active_time: 0.1 };
    components["minecraft:particle_appearance_billboard"] = {
      size: ["0.2 + variable.particle_age * 8", "0.2 + variable.particle_age * 8"],
      facing_camera_mode: "emitter_transform_xz"
    };
  } else {
    components["minecraft:emitter_rate_steady"] = { spawn_rate: 8, max_particles: 24 };
    components["minecraft:emitter_lifetime_once"] = { active_time: 2 };
    components["minecraft:particle_initial_speed"] = [0.2, 0.6, 0.2];
    components["minecraft:particle_motion_dynamic"] = { linear_acceleration: [0, 0.2, 0], linear_drag_coefficient: 1.2 };
  }
  return base;
}
