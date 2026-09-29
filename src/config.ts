import { access, mkdir, readFile } from "node:fs/promises";
import { constants, existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./safe-file.js";
import type { ProjectConfig } from "./types.js";

interface RawProjectConfig {
  projectName?: string;
  particlesRoot?: string;
  resourcePackRoot?: string;
  selectorsFile?: string;
  instanceSelectorsFile?: string;
  spellFile?: string;
  referenceVideosRoot?: string;
  artifactsRoot?: string;
}

interface ParsedConfig {
  projects: Map<string, RawProjectConfig>;
  activeProject: string;
  sharedTextureBanks?: string[];
}

const defaultConfigName = "snowstorm-mcp.config.json";

function resolveConfigPath(configPath?: string): string {
  return path.resolve(configPath ?? process.env.SNOWSTORM_MCP_CONFIG ?? defaultConfigName);
}

function resolveValue(configDirectory: string, value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing '${name}' in Snowstorm MCP configuration.`);
  return path.resolve(configDirectory, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function compareProjectKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function defaultProjectKey(projects: Map<string, RawProjectConfig>): string {
  return [...projects.keys()].sort(compareProjectKeys)[0] as string;
}

function validateActiveProject(value: unknown, projects: Map<string, RawProjectConfig>, configPath: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`'activeProject' in Snowstorm MCP configuration at ${configPath} must be a non-blank string.`);
  }
  if (!projects.has(value)) {
    throw new Error(`Active project '${value}' is not defined in Snowstorm MCP configuration at ${configPath}.`);
  }
  return value;
}

function parseConfig(rawText: string, configPath: string): ParsedConfig {
  let root: unknown;
  try {
    root = JSON.parse(rawText) as unknown;
  } catch (error) {
    throw new Error(`Unable to load Snowstorm MCP configuration at ${configPath}: ${String(error)}`);
  }
  if (!isRecord(root)) throw new Error(`Snowstorm MCP configuration at ${configPath} must be a JSON object.`);

  const projects = new Map<string, RawProjectConfig>();
  if (Object.hasOwn(root, "projects")) {
    if (!isRecord(root.projects) || Object.keys(root.projects).length === 0) {
      throw new Error(`'projects' in Snowstorm MCP configuration at ${configPath} must be a non-empty object.`);
    }
    for (const [key, project] of Object.entries(root.projects)) {
      if (!key.trim() || !isRecord(project)) {
        throw new Error(`Project '${key}' in Snowstorm MCP configuration at ${configPath} must be a JSON object with a non-empty key.`);
      }
      projects.set(key, project as RawProjectConfig);
    }
    const activeProject = Object.hasOwn(root, "activeProject")
      ? validateActiveProject(root.activeProject, projects, configPath)
      : defaultProjectKey(projects);
    return {
      projects,
      activeProject,
      ...(root.sharedTextureBanks === undefined ? {} : { sharedTextureBanks: root.sharedTextureBanks as string[] })
    };
  }

  if (root.projectName !== undefined && typeof root.projectName !== "string") {
    throw new Error(`'projectName' in Snowstorm MCP configuration at ${configPath} must be a string.`);
  }
  const projectName = typeof root.projectName === "string" && root.projectName.trim() ? root.projectName : undefined;
  const implicitKey = projectName ?? "default";
  projects.set(implicitKey, root as RawProjectConfig);
  const activeProject = Object.hasOwn(root, "activeProject")
    ? validateActiveProject(root.activeProject, projects, configPath)
    : implicitKey;
  return {
    projects,
    activeProject,
    ...(root.sharedTextureBanks === undefined ? {} : { sharedTextureBanks: root.sharedTextureBanks as string[] })
  };
}

function definitionsDigest(parsed: ParsedConfig): string {
  const projects = Object.fromEntries([...parsed.projects.entries()].sort(([left], [right]) => compareProjectKeys(left, right)));
  return sha256(JSON.stringify(stableValue({ projects, sharedTextureBanks: parsed.sharedTextureBanks })));
}

async function requirePath(target: string, name: string): Promise<void> {
  try {
    await access(target, constants.R_OK);
  } catch {
    throw new Error(`Configured ${name} is not readable: ${target}`);
  }
}

async function loadProjectConfig(
  configPath: string,
  rawText: string,
  parsed: ParsedConfig,
  projectKey: string
): Promise<ProjectConfig> {
  const configDirectory = path.dirname(configPath);
  const raw = parsed.projects.get(projectKey);
  if (!raw) throw new Error(`Unknown project '${projectKey}'. Known projects: ${[...parsed.projects.keys()].join(", ")}.`);

  const sharedTextureBanksRaw = parsed.sharedTextureBanks;
  if (sharedTextureBanksRaw !== undefined && (!Array.isArray(sharedTextureBanksRaw)
    || sharedTextureBanksRaw.length > 16
    || sharedTextureBanksRaw.some((bank) => typeof bank !== "string" || !bank.trim()))) {
    throw new Error("'sharedTextureBanks' must be an array of at most 16 non-empty paths.");
  }
  const sharedTextureBanks = sharedTextureBanksRaw?.map((bank, index) =>
    resolveValue(configDirectory, bank, `sharedTextureBanks[${index}]`)
  ) ?? [];
  if (raw.projectName !== undefined && typeof raw.projectName !== "string") {
    throw new Error(`'projectName' for project '${projectKey}' must be a string.`);
  }
  const artifactsRoot = resolveValue(configDirectory, raw.artifactsRoot, "artifactsRoot");
  const instanceSelectorsFile = raw.instanceSelectorsFile === undefined
    ? undefined
    : resolveValue(configDirectory, raw.instanceSelectorsFile, "instanceSelectorsFile");
  const referenceVideosRoot = raw.referenceVideosRoot
    ? path.resolve(configDirectory, raw.referenceVideosRoot)
    : path.join(artifactsRoot, "reference-videos");
  const config: ProjectConfig = {
    configPath,
    configDigest: sha256(rawText),
    configDefinitionsDigest: definitionsDigest(parsed),
    projectName: raw.projectName?.trim() ? raw.projectName : (parsed.projects.size > 1 ? projectKey : "snowstorm-project"),
    particlesRoot: resolveValue(configDirectory, raw.particlesRoot, "particlesRoot"),
    resourcePackRoot: resolveValue(configDirectory, raw.resourcePackRoot, "resourcePackRoot"),
    sharedTextureBanks,
    selectorsFile: resolveValue(configDirectory, raw.selectorsFile, "selectorsFile"),
    ...(instanceSelectorsFile ? { instanceSelectorsFile } : {}),
    spellFile: resolveValue(configDirectory, raw.spellFile, "spellFile"),
    referenceVideosRoot,
    artifactsRoot
  };
  await mkdir(config.artifactsRoot, { recursive: true });
  await mkdir(config.referenceVideosRoot, { recursive: true });

  await Promise.all([
    requirePath(config.particlesRoot, "particlesRoot"),
    requirePath(config.resourcePackRoot, "resourcePackRoot"),
    requirePath(config.selectorsFile, "selectorsFile"),
    ...(config.instanceSelectorsFile ? [requirePath(config.instanceSelectorsFile, "instanceSelectorsFile")] : []),
    requirePath(config.spellFile, "spellFile")
  ]);
  return config;
}

export class ProjectRegistry {
  private activeProjectKey: string;
  private currentConfigValue?: ProjectConfig;

  private constructor(
    private readonly configPath: string,
    private readonly rawText: string,
    private readonly parsed: ParsedConfig
  ) {
    this.activeProjectKey = parsed.activeProject;
  }

  static async load(configPath?: string): Promise<ProjectRegistry> {
    const resolvedConfigPath = resolveConfigPath(configPath);
    let rawText: string;
    try {
      rawText = await readFile(resolvedConfigPath, "utf8");
    } catch (error) {
      throw new Error(`Unable to load Snowstorm MCP configuration at ${resolvedConfigPath}: ${String(error)}`);
    }
    const parsed = parseConfig(rawText, resolvedConfigPath);
    const registry = new ProjectRegistry(resolvedConfigPath, rawText, parsed);
    await registry.activate(parsed.activeProject);
    return registry;
  }

  get activeProject(): string {
    return this.activeProjectKey;
  }

  get currentConfig(): ProjectConfig {
    if (!this.currentConfigValue) throw new Error("Project registry has no active configuration.");
    return this.currentConfigValue;
  }

  list(): string[] {
    return [...this.parsed.projects.keys()];
  }

  assertCurrent(): void {
    if (this.currentConfigValue) assertConfigCurrent(this.currentConfigValue);
  }

  async use(projectKey: string): Promise<ProjectConfig> {
    this.assertCurrent();
    await this.activate(projectKey);
    return this.currentConfig;
  }

  private async activate(projectKey: string): Promise<void> {
    if (!this.parsed.projects.has(projectKey)) {
      throw new Error(`Unknown project '${projectKey}'. Known projects: ${this.list().join(", ")}.`);
    }
    const config = await loadProjectConfig(this.configPath, this.rawText, this.parsed, projectKey);
    this.activeProjectKey = projectKey;
    this.currentConfigValue = config;
  }
}

export async function loadConfig(configPath?: string): Promise<ProjectConfig> {
  const registry = await ProjectRegistry.load(configPath);
  return registry.currentConfig;
}

export function assertConfigCurrent(config: ProjectConfig): void {
  if (!config.configDigest) return;
  let current: string;
  try {
    current = readFileSync(config.configPath, "utf8");
  } catch {
    return;
  }
  if (sha256(current) === config.configDigest) return;
  if (config.configDefinitionsDigest) {
    try {
      if (definitionsDigest(parseConfig(current, config.configPath)) === config.configDefinitionsDigest) return;
    } catch {
      // A malformed on-disk replacement still requires reloading the configuration.
    }
  }
  throw new Error(
    `${config.configPath} changed on disk. This server is still bound to project '${config.projectName}' (particles root ${config.particlesRoot}). Project definitions changed. Restart the MCP server to load the new configuration.`
  );
}

export function describeConfigBinding(config: ProjectConfig): string {
  return `Server is bound to project '${config.projectName}' (particles root ${config.particlesRoot}).`;
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
  const projectVendor = path.join(projectRoot, "vendor", "snowstorm");
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const normalized = resourcesPath.replaceAll("\\", "/");
    if (!normalized.endsWith("node_modules/electron/dist/resources")) {
      const packaged = path.join(resourcesPath, "snowstorm");
      if (existsSync(packaged)) {
        return packaged;
      }
    }
    return projectVendor;
  }
  if (existsSync(projectVendor)) return projectVendor;
  const packageVendor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "snowstorm");
  return existsSync(packageVendor) ? packageVendor : projectVendor;
}
