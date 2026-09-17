import { access, readFile } from "node:fs/promises";
import { constants, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "./types.js";

interface RawConfig {
  projectName?: string;
  particlesRoot?: string;
  resourcePackRoot?: string;
  selectorsFile?: string;
  spellFile?: string;
  referenceVideosRoot?: string;
  artifactsRoot?: string;
}

const defaultConfigName = "snowstorm-mcp.config.json";

function resolveConfigPath(configPath?: string): string {
  return path.resolve(configPath ?? process.env.SNOWSTORM_MCP_CONFIG ?? defaultConfigName);
}

function resolveValue(configDirectory: string, value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing '${name}' in Snowstorm MCP configuration.`);
  return path.resolve(configDirectory, value);
}

async function requirePath(target: string, name: string): Promise<void> {
  try {
    await access(target, constants.R_OK);
  } catch {
    throw new Error(`Configured ${name} is not readable: ${target}`);
  }
}

export async function loadConfig(configPath?: string): Promise<ProjectConfig> {
  const resolvedConfigPath = resolveConfigPath(configPath);
  const configDirectory = path.dirname(resolvedConfigPath);
  let raw: RawConfig;

  try {
    raw = JSON.parse(await readFile(resolvedConfigPath, "utf8")) as RawConfig;
  } catch (error) {
    throw new Error(`Unable to load Snowstorm MCP configuration at ${resolvedConfigPath}: ${String(error)}`);
  }

  const config: ProjectConfig = {
    configPath: resolvedConfigPath,
    projectName: raw.projectName ?? "snowstorm-project",
    particlesRoot: resolveValue(configDirectory, raw.particlesRoot, "particlesRoot"),
    resourcePackRoot: resolveValue(configDirectory, raw.resourcePackRoot, "resourcePackRoot"),
    selectorsFile: resolveValue(configDirectory, raw.selectorsFile, "selectorsFile"),
    spellFile: resolveValue(configDirectory, raw.spellFile, "spellFile"),
    referenceVideosRoot: resolveValue(configDirectory, raw.referenceVideosRoot, "referenceVideosRoot"),
    artifactsRoot: resolveValue(configDirectory, raw.artifactsRoot, "artifactsRoot")
  };

  await Promise.all([
    requirePath(config.particlesRoot, "particlesRoot"),
    requirePath(config.resourcePackRoot, "resourcePackRoot"),
    requirePath(config.selectorsFile, "selectorsFile"),
    requirePath(config.spellFile, "spellFile"),
    requirePath(config.referenceVideosRoot, "referenceVideosRoot")
  ]);
  return config;
}

export function requirePathInside(root: string, requestedPath: string): string {
  const candidate = path.resolve(root, requestedPath);
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return candidate;
  }
  throw new Error(`Path escapes the configured root: ${requestedPath}`);
}

export function requireResolvedPathInside(root: string, requestedPath: string): string {
  const candidate = requirePathInside(root, requestedPath);
  const canonicalRoot = realpathSync.native(root);
  let existing = candidate;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`No existing parent for path: ${requestedPath}`);
    existing = parent;
  }
  const canonicalExisting = realpathSync.native(existing);
  const relative = path.relative(canonicalRoot, canonicalExisting);
  if (relative !== "" && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
    throw new Error(`Path escapes the configured root through a symlink or junction: ${requestedPath}`);
  }
  return path.join(canonicalExisting, path.relative(existing, candidate));
}

export function snowstormRoot(projectRoot: string): string {
  if (process.env.SNOWSTORM_MCP_SNOWSTORM_ROOT) {
    return path.resolve(process.env.SNOWSTORM_MCP_SNOWSTORM_ROOT);
  }
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath && !resourcesPath.endsWith("node_modules/electron/dist/resources")) {
    const packaged = path.join(resourcesPath, "snowstorm");
    return packaged;
  }
  return path.join(projectRoot, "vendor", "snowstorm");
}
