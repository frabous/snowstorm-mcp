import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectConfig } from "./types.js";

export function mcpPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function projectRoot(config: ProjectConfig): string {
  return path.dirname(config.configPath);
}
