import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { accessMock, spawnMock, unrefMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  spawnMock: vi.fn(),
  unrefMock: vi.fn()
}));

vi.mock("node:fs/promises", () => ({ access: accessMock }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { openDesktop } from "../src/desktop-launcher.js";
import { mcpPackageRoot } from "../src/project-path.js";
import type { ParticleStore } from "../src/particle-store.js";
import type { ProjectConfig } from "../src/types.js";

describe("openDesktop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReturnValue({ pid: 123, unref: unrefMock });
  });

  it("resolves the MCP package root relative to its source module", () => {
    const expectedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

    expect(mcpPackageRoot()).toBe(expectedRoot);
  });

  it("launches Electron from the MCP package with the selected config and particle", async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const target = path.join("separate-project", "particles", "test.particle.json");
    const config = { configPath: path.resolve("separate-project", "snowstorm-mcp.config.json") } as ProjectConfig;
    const store = { resolve: vi.fn(() => target) } as unknown as ParticleStore;
    const executable = process.platform === "win32"
      ? path.join(packageRoot, "node_modules", "electron", "dist", "electron.exe")
      : path.join(packageRoot, "node_modules", ".bin", "electron");

    await expect(openDesktop(store, config, "test.particle.json")).resolves.toEqual({ pid: 123 });

    expect(store.resolve).toHaveBeenCalledWith("test.particle.json");
    expect(accessMock).toHaveBeenNthCalledWith(1, target);
    expect(accessMock).toHaveBeenNthCalledWith(2, executable);
    expect(spawnMock).toHaveBeenCalledWith(executable, [packageRoot, target], {
      cwd: packageRoot,
      detached: true,
      env: { ...process.env, SNOWSTORM_MCP_CONFIG: config.configPath },
      stdio: "ignore",
      windowsHide: false
    });
    expect(unrefMock).toHaveBeenCalledOnce();
  });
});
