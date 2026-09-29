import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { mergeSelectors } from "../src/selectors-merge.js";
import { sha256 } from "../src/safe-file.js";
import type { ProjectConfig } from "../src/types.js";
import { projectFixture } from "./fixtures.js";

function selector(name: string, scheme: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    type: "*",
    enabled: true,
    morph: `particle_morph: {Scheme:"${scheme}"}`,
    ...extra
  };
}

async function mergeFixture(root: string, fragment: unknown[], existing: unknown[]) {
  const config = await projectFixture(root);
  const target = path.join(root, "instance", "selectors.json");
  await mkdir(path.dirname(target), { recursive: true });
  config.instanceSelectorsFile = target;
  await writeFile(config.selectorsFile, `${JSON.stringify(fragment, null, 2)}\n`);
  const targetRaw = `${JSON.stringify(existing, null, 2)}\n`;
  await writeFile(target, targetRaw);
  return { config, target, targetRaw };
}

describe("selectors_merge", () => {
  it("proposes additive selectors without changing existing entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-selectors-"));
    const current = selector("instance-only", "instance_particle");
    const addition = selector("package-effect", "package_particle");
    const { config, target, targetRaw } = await mergeFixture(root, [addition], [current]);

    const result = await mergeSelectors(config, { instanceFile: target });

    expect(result.added).toEqual([addition]);
    expect(result.merged).toEqual([current, addition]);
    expect(result.counts).toMatchObject({ added: 1, conflicts: 0, orphans: 1 });
    expect(await readFile(target, "utf8")).toBe(targetRaw);
  });

  it("reports an identical selector as already present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-selectors-"));
    const existing = selector("same", "same_particle");
    const { config, target } = await mergeFixture(root, [existing], [existing]);

    const result = await mergeSelectors(config, { instanceFile: target });

    expect(result.added).toEqual([]);
    expect(result.alreadyPresent).toEqual([{ fragmentIndex: 0, existingIndex: 0, selector: existing }]);
    expect(result.merged).toEqual([existing]);
  });

  it.each([
    {
      label: "name",
      existing: selector("shared-name", "instance_particle"),
      incoming: selector("shared-name", "package_particle"),
      reason: "name"
    },
    {
      label: "Scheme",
      existing: selector("instance-name", "shared_particle"),
      incoming: selector("package-name", "shared_particle"),
      reason: "scheme"
    }
  ])("reports a $label collision without replacing the existing selector", async ({ existing, incoming, reason }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-selectors-"));
    const { config, target, targetRaw } = await mergeFixture(root, [incoming], [existing]);

    const result = await mergeSelectors(config, { instanceFile: target });

    expect(result.added).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.existing[0]?.reasons).toContain(reason);
    expect(result.merged).toEqual([existing]);
    expect(await readFile(target, "utf8")).toBe(targetRaw);
  });

  it("writes a unique dry-run artifact with the proposed merged array", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-selectors-"));
    const existing = selector("kept", "kept_particle");
    const addition = selector("added", "added_particle");
    const { config, target, targetRaw } = await mergeFixture(root, [addition], [existing]);

    const result = await mergeSelectors(config, { instanceFile: target, dryRun: true, write: true });

    expect(result.written).toBe(false);
    expect(result.reportFile).toBeTruthy();
    expect(await readFile(target, "utf8")).toBe(targetRaw);
    const report = JSON.parse(await readFile(result.reportFile!, "utf8")) as { proposedMerged: unknown[] };
    expect(report.proposedMerged).toEqual([existing, addition]);
  });

  it("writes only with both live-write flags, verifies the digest, and backs up the original", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-selectors-"));
    const existing = selector("kept", "kept_particle");
    const addition = selector("added", "added_particle");
    const { config, target, targetRaw } = await mergeFixture(root, [addition], [existing]);

    const result = await mergeSelectors(config, {
      instanceFile: target,
      dryRun: false,
      write: true,
      expectedDigest: sha256(targetRaw)
    });

    const writtenRaw = await readFile(target, "utf8");
    expect(result.written).toBe(true);
    expect(result.digestBefore).toBe(sha256(targetRaw));
    expect(result.digestAfter).toBe(sha256(writtenRaw));
    expect(JSON.parse(writtenRaw)).toEqual([existing, addition]);
    expect(result.backup).toBeTruthy();
    expect(await readFile(result.backup!, "utf8")).toBe(targetRaw);
  });

  it("runs the optional guard immediately before replacing the configured file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-selectors-"));
    const targetExisting = selector("kept", "kept_particle");
    const addition = selector("added", "added_particle");
    const { config, target, targetRaw } = await mergeFixture(root, [addition], [targetExisting]);

    await expect(mergeSelectors(config, {
      dryRun: false,
      write: true,
      expectedDigest: sha256(targetRaw)
    }, () => { throw new Error("configuration changed"); })).rejects.toThrow("configuration changed");
    expect(await readFile(target, "utf8")).toBe(targetRaw);
  });

  it("rejects stale writes and requires a digest for live writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-selectors-"));
    const { config, target, targetRaw } = await mergeFixture(root, [selector("added", "added_particle")], []);

    await expect(mergeSelectors(config, { instanceFile: target, dryRun: false, write: true }))
      .rejects.toThrow("expectedDigest is required");
    await expect(mergeSelectors(config, {
      instanceFile: target,
      dryRun: false,
      write: true,
      expectedDigest: "0".repeat(64)
    })).rejects.toThrow("changed since it was read");
    expect(await readFile(target, "utf8")).toBe(targetRaw);
  });

  it("requires live writes to use the configured instance selectors path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-selectors-"));
    const { config, target, targetRaw } = await mergeFixture(root, [selector("added", "added_particle")], []);
    const otherTarget = path.join(root, "other", "selectors.json");
    await mkdir(path.dirname(otherTarget), { recursive: true });
    await writeFile(otherTarget, "[]\n");

    await expect(mergeSelectors(config, {
      instanceFile: otherTarget,
      dryRun: false,
      write: true,
      expectedDigest: sha256("[]\n")
    })).rejects.toThrow("must target the configured instanceSelectorsFile");
    expect(await readFile(target, "utf8")).toBe(targetRaw);
    expect(await readFile(otherTarget, "utf8")).toBe("[]\n");
  });

  it("requires a target and reports unreadable configured or explicit paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-selectors-"));
    const config = await projectFixture(root);

    await expect(mergeSelectors(config)).rejects.toThrow("Pass instanceFile or configure instanceSelectorsFile");
    await expect(mergeSelectors(config, { instanceFile: path.join(root, "missing", "selectors.json") }))
      .rejects.toThrow("Unable to read instance selectors file");

    const configuredTarget = path.join(root, "configured", "selectors.json");
    await mkdir(path.dirname(configuredTarget), { recursive: true });
    await writeFile(configuredTarget, "[]\n");
    await writeFile(path.join(root, "configured.json"), JSON.stringify({
      projectName: "test",
      particlesRoot: "./particles",
      resourcePackRoot: "./resource-pack",
      selectorsFile: "./selectors.json",
      instanceSelectorsFile: "./configured/selectors.json",
      spellFile: "./spells.yml",
      artifactsRoot: "./artifacts"
    }));
    const loaded = await loadConfig(path.join(root, "configured.json"));
    expect(loaded.instanceSelectorsFile).toBe(configuredTarget);
    await writeFile(config.selectorsFile, `${JSON.stringify([selector("from-config", "configured_particle")])}\n`);
    const configuredMerge = await mergeSelectors(loaded);
    expect(configuredMerge.instanceFile).toBe(configuredTarget);
    expect(configuredMerge.merged).toEqual([selector("from-config", "configured_particle")]);

    await writeFile(path.join(root, "configured.json"), JSON.stringify({
      projectName: "test",
      particlesRoot: "./particles",
      resourcePackRoot: "./resource-pack",
      selectorsFile: "./selectors.json",
      instanceSelectorsFile: "./configured/missing.json",
      spellFile: "./spells.yml",
      artifactsRoot: "./artifacts"
    }));
    await expect(loadConfig(path.join(root, "configured.json"))).rejects.toThrow("Configured instanceSelectorsFile is not readable");
  });
});
