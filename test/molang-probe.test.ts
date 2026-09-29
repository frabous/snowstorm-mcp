import { describe, expect, it } from "vitest";
import { combine } from "../src/molang-probe.js";

describe("probe cross-field combination", () => {
  it("reduces several fields into one scalar series", () => {
    expect(combine("multiply", [7, 0.55])).toBeCloseTo(3.85);
    expect(combine("divide", [10, 4])).toBeCloseTo(2.5);
    expect(combine("add", [1, 2, 3])).toBe(6);
    expect(combine("subtract", [10, 3])).toBe(7);
    expect(combine("min", [5, 2, 9])).toBe(2);
    expect(combine("max", [5, 2, 9])).toBe(9);
  });

  it("guards the arity each operator actually needs", () => {
    expect(() => combine("divide", [10])).toThrow("at least two fields");
    expect(() => combine("multiply", [])).toThrow("at least one field");
    expect(combine("min", [4])).toBe(4);
  });
});
