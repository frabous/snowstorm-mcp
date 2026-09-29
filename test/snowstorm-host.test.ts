import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startSnowstormHost } from "../src/snowstorm-host.js";

async function fetchAutomationBundle(source: string): Promise<{ status: number; body: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "snowstorm-host-"));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "app.js"), source, "utf8");
  const host = await startSnowstormHost(root, false, true);
  try {
    const response = await fetch(`${host.url}/dist/app.js`);
    return { status: response.status, body: await response.text() };
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe("pinned Snowstorm automation bridge", () => {
  const hook = "window.Emitter=Pw,";
  const replacement = "window.__preview=Qx,window.__engine=_x,window.Emitter=Pw,";

  it("injects the bridge when the pinned hook occurs exactly once", async () => {
    const response = await fetchAutomationBundle(`before();${hook}after();`);

    expect(response).toEqual({ status: 200, body: `before();${replacement}after();` });
  });

  it.each([
    ["missing", "before();after();"],
    ["duplicated", `${hook}${hook}`]
  ])("fails closed when the pinned hook is %s", async (_condition, source) => {
    const response = await fetchAutomationBundle(source);

    expect(response.status).toBe(404);
  });
});
