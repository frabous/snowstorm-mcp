import { describe, expect, it } from "vitest";
import { sceneCameraSchema } from "../src/input-schema.js";

describe("scene input schema", () => {
  it("normalizes numeric camera strings to finite coordinates", () => {
    expect(sceneCameraSchema.parse({
      position: ["70", "46.5", "8.5e1"],
      target: [0, "24", 0]
    })).toEqual({ position: [70, 46.5, 85], target: [0, 24, 0] });
  });

  it("rejects non-numeric and non-finite camera strings", () => {
    expect(() => sceneCameraSchema.parse({ position: ["NaN", 0, 0], target: [0, 0, 0] })).toThrow();
    expect(() => sceneCameraSchema.parse({ position: ["1e309", 0, 0], target: [0, 0, 0] })).toThrow();
  });
});
