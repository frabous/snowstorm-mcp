import { describe, expect, it } from "vitest";
import { authoringGuideFor } from "../src/authoring-guide.js";

describe("authoring guide conventions", () => {
  it("distinguishes JSON constants from Molang and preserves emitter conventions", () => {
    const components = authoringGuideFor("components");
    expect(components).toMatch(/numeric constants are JSON numbers; Molang expressions are strings/i);
    expect(components).toMatch(/spawn_rate a plain number/i);
    expect(components).toMatch(/leading zero/i);

    expect(authoringGuideFor("blockbuster")).toMatch(/preserve every blockbuster:\* field on every emitter/i);
  });

  it("documents the requested texture recipes and tint guidance", () => {
    const textures = authoringGuideFor("textures");
    expect(textures).toMatch(/soft_lens.*broad.*bright.*mip reduction/i);
    expect(textures).toMatch(/anime_cloud.*non-harmonic.*noise modulation.*edge erosion.*preserving its center/i);
    expect(textures).toMatch(/faceted crystal.*bokeh.*puff/i);
    expect(textures).toMatch(/pre-colored textures.*neutral\/white tint/i);
  });

  it("states angle units and the per-emitter rotation limitation", () => {
    expect(authoringGuideFor("motion")).toMatch(/Molang angles are degrees, not radians/i);
    expect(authoringGuideFor("motion")).toMatch(/per-emitter intra-shot rotation is unavailable/i);
  });

  it("separates Snowstorm preview evidence from Minecraft verification", () => {
    expect(authoringGuideFor("validation")).toMatch(/Snowstorm preview\/render proves only the local simulator, never Minecraft playback/i);
  });
});
