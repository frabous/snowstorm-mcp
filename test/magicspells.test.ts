import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectSpellTimeline, retimeSpell } from "../src/magicspells.js";
import { projectFixture } from "./fixtures.js";

const spellSource = `# timing fixture
main:
  spell-class: .MultiSpell
  spells:
    - helper_a
    - DELAY 5
    - helper_b
helper_a:
  spell-class: .buff.ArmorStandSpell
  custom-name: a
  duration: 2
  cancel-on-logout: true
  cancel-on-teleport: true
helper_b:
  spell-class: .buff.ArmorStandSpell
  custom-name: b
  duration: 2
  cancel-on-logout: true
  cancel-on-teleport: true
`;

describe("MagicSpells timeline", () => {
  it("computes cumulative starts and retimes on the tick grid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-spell-"));
    const config = await projectFixture(root);
    await writeFile(config.spellFile, spellSource);
    const before = await inspectSpellTimeline(config, "main", 20);
    expect(before.starts).toEqual({ helper_a: 0, helper_b: 5 });
    const dryRun = await retimeSpell(config, {
      mainSpell: "main",
      expectedDigest: before.digest,
      starts: { helper_a: 0, helper_b: 0.5 },
      unit: "seconds",
      ticksPerSecond: 20,
      dryRun: true
    });
    expect(dryRun.sequence).toEqual(["helper_a", "DELAY 10", "helper_b"]);
    expect(await readFile(config.spellFile, "utf8")).toBe(spellSource);
    await retimeSpell(config, { mainSpell: "main", expectedDigest: before.digest, starts: { helper_a: 0, helper_b: 0.5 }, unit: "seconds", dryRun: false });
    expect((await inspectSpellTimeline(config, "main", 20)).starts.helper_b).toBe(10);
  });

  it("rejects duplicate YAML keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-spell-"));
    const config = await projectFixture(root);
    await writeFile(config.spellFile, "spell:\n  spell-class: .MultiSpell\nspell:\n  spell-class: .MultiSpell\n");
    const result = await inspectSpellTimeline(config, "spell");
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "error", code: "spell-yaml" }));
  });

  it("preserves parameterized repeated helper occurrences during retiming", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-spell-"));
    const config = await projectFixture(root);
    await writeFile(config.spellFile, `main:
  spell-class: .MultiSpell
  spells:
    - helper(mode=first)
    - DELAY 5
    - helper(mode=second)
helper:
  spell-class: .buff.ArmorStandSpell
  custom-name: test
  duration: 2
  cancel-on-logout: true
  cancel-on-teleport: true
`);
    const timeline = await inspectSpellTimeline(config, "main", 100);
    expect(timeline.occurrences).toEqual([
      expect.objectContaining({ id: "0:helper", invocation: "helper(mode=first)", startTicks: 0 }),
      expect.objectContaining({ id: "2:helper", invocation: "helper(mode=second)", startTicks: 5 })
    ]);
    const result = await retimeSpell(config, {
      mainSpell: "main",
      expectedDigest: timeline.digest,
      starts: { "2:helper": 0.29 },
      unit: "seconds",
      ticksPerSecond: 100,
      dryRun: true
    });
    expect(result.sequence).toEqual(["helper(mode=first)", "DELAY 29", "helper(mode=second)"]);
  });

  it("uses the same six-hour limit at non-default tick rates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-spell-"));
    const config = await projectFixture(root);
    await writeFile(config.spellFile, spellSource);
    const timeline = await inspectSpellTimeline(config, "main", 100);
    await retimeSpell(config, {
      mainSpell: "main",
      expectedDigest: timeline.digest,
      starts: { helper_b: 5000 },
      unit: "seconds",
      ticksPerSecond: 100,
      dryRun: false
    });
    const inspected = await inspectSpellTimeline(config, "main", 100);
    expect(inspected.starts.helper_b).toBe(500_000);
    expect(inspected.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    await expect(retimeSpell(config, {
      mainSpell: "main",
      expectedDigest: inspected.digest,
      starts: { helper_b: 21_601 },
      unit: "seconds",
      ticksPerSecond: 100,
      dryRun: true
    })).rejects.toThrow("within six hours");
  });
});
