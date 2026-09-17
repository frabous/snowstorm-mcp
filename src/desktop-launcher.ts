import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { ParticleStore } from "./particle-store.js";
import type { ProjectConfig } from "./types.js";

export async function openDesktop(store: ParticleStore, config: ProjectConfig, file: string): Promise<{ pid: number }> {
  const target = store.resolve(file);
  await access(target);
  const projectRoot = path.dirname(config.configPath);
  const executable = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  await access(executable);
  const child = spawn(executable, [projectRoot, target], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  if (!child.pid) throw new Error("Electron did not start.");
  return { pid: child.pid };
}
