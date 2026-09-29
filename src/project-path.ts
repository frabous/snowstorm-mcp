import path from "node:path";
import type { ProjectConfig } from "./types.js";

export function projectRoot(config: ProjectConfig): string {
  return path.dirname(config.configPath);
}
