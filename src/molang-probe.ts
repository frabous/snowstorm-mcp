import { chromium } from "playwright";
import path from "node:path";
import type { JsonObject, JsonValue, ProjectConfig } from "./types.js";
import type { ParticleStore } from "./particle-store.js";
import { valueAt } from "./particle-store.js";
import { startSnowstormHost } from "./snowstorm-host.js";
import { snowstormRoot } from "./config.js";

export interface MolangSample {
  age: number;
  lifetime?: number;
  emitterAge?: number;
  random?: [number, number, number, number];
  variables?: Record<string, number>;
}

export interface ProbeAssertion {
  field: string;
  sampleIndexes: number[];
  metric: "value" | "length" | "distance";
  direction?: "increasing" | "decreasing";
  center?: number[];
  minRatio?: number;
  maxRatio?: number;
}

function projectRoot(config: ProjectConfig): string {
  return path.dirname(config.configPath);
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Molang probe exceeded ${milliseconds}ms.`)), milliseconds);
    operation.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); }
    );
  });
}

function expressionValue(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "number" || typeof entry === "string")) return value;
  return undefined;
}

function metric(value: JsonValue, assertion: ProbeAssertion): number {
  if (assertion.metric === "value") {
    if (typeof value !== "number") throw new Error(`${assertion.field} is not numeric.`);
    return value;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "number")) throw new Error(`${assertion.field} is not a numeric vector.`);
  const numbers = value as number[];
  if (assertion.metric === "length") return Math.hypot(...numbers);
  const center = assertion.center ?? new Array(numbers.length).fill(0);
  if (center.length !== numbers.length) throw new Error(`${assertion.field} assertion center has the wrong dimensions.`);
  return Math.hypot(...numbers.map((entry, index) => entry - center[index]!));
}

export async function probeParticle(
  store: ParticleStore,
  config: ProjectConfig,
  options: { file: string; select: Record<string, string>; samples: MolangSample[]; assertions?: ProbeAssertion[]; seed?: number }
) {
  if (!Object.keys(options.select).length || Object.keys(options.select).length > 8) throw new Error("Probe requires 1 to 8 selected fields.");
  if (!options.samples.length || options.samples.length > 32) throw new Error("Probe requires 1 to 32 samples.");
  const document = await store.read(options.file);
  const fields = Object.fromEntries(Object.entries(options.select).map(([label, pointer]) => {
    const selected = expressionValue(valueAt(document, pointer));
    if (selected === undefined) throw new Error(`Probe field '${label}' must resolve to a number, expression, or flat expression vector.`);
    return [label, selected];
  }));
  const host = await startSnowstormHost(snowstormRoot(projectRoot(config)));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${host.url}/index.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean((window as typeof window & { Emitter?: unknown }).Emitter));
    await page.evaluate((seed) => {
      let state = seed >>> 0;
      Math.random = () => {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
      };
    }, options.seed ?? 1);
    const rows = await withTimeout(page.evaluate((payload: string) => {
      const { fields, samples } = JSON.parse(payload) as {
        fields: Record<string, number | string | Array<number | string>>;
        samples: MolangSample[];
      };
      const emitter = (window as typeof window & { Emitter: any }).Emitter;
      const evaluate = (value: unknown, variables: Record<string, number>): unknown => {
        if (typeof value === "number") return value;
        if (typeof value === "string") return emitter.Molang.parse(value, variables);
        if (Array.isArray(value)) return value.map((entry) => evaluate(entry, variables));
        return null;
      };
      return samples.map((sample) => {
        const random = sample.random ?? [0.5, 0.5, 0.5, 0.5];
        const variables: Record<string, number> = {
          "variable.particle_age": sample.age,
          "variable.particle_lifetime": sample.lifetime ?? 1,
          "variable.emitter_age": sample.emitterAge ?? sample.age,
          "variable.particle_random_1": random[0],
          "variable.particle_random_2": random[1],
          "variable.particle_random_3": random[2],
          "variable.particle_random_4": random[3],
          ...(sample.variables ?? {})
        };
        emitter.Molang.resetVariables();
        return { input: sample, values: Object.fromEntries(Object.entries(fields).map(([label, value]) => [label, evaluate(value, variables)])) };
      });
    }, JSON.stringify({ fields, samples: options.samples })), 10_000) as Array<{ input: MolangSample; values: Record<string, JsonValue> }>;
    const assertions = (options.assertions ?? []).map((assertion) => {
      const values = assertion.sampleIndexes.map((index) => {
        const row = rows[index];
        if (!row) throw new Error(`Assertion sample index ${index} is out of range.`);
        const value = row.values[assertion.field] as JsonValue | undefined;
        if (value === undefined) throw new Error(`Assertion references unknown field '${assertion.field}'.`);
        return metric(value, assertion);
      });
      let passed = true;
      if (assertion.direction === "increasing") passed = values.every((value, index) => index === 0 || value > values[index - 1]!);
      if (assertion.direction === "decreasing") passed = values.every((value, index) => index === 0 || value < values[index - 1]!);
      if (assertion.minRatio !== undefined) passed = passed && values.at(-1)! / values[0]! >= assertion.minRatio;
      if (assertion.maxRatio !== undefined) passed = passed && values.at(-1)! / values[0]! <= assertion.maxRatio;
      return { ...assertion, values, passed };
    });
    return { valid: assertions.every((assertion) => assertion.passed), seed: options.seed ?? 1, fields: Object.keys(fields), samples: rows, assertions };
  } finally {
    await Promise.allSettled([browser?.close(), host.close()]);
  }
}
