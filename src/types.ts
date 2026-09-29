export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ProjectConfig {
  configPath: string;
  configDigest?: string;
  configDefinitionsDigest?: string;
  projectName: string;
  particlesRoot: string;
  resourcePackRoot: string;
  sharedTextureBanks?: string[];
  selectorsFile: string;
  instanceSelectorsFile?: string;
  spellFile: string;
  referenceVideosRoot: string;
  artifactsRoot: string;
}

export interface JsonPatchOperation {
  op: "add" | "remove" | "replace" | "test";
  path: string;
  value?: JsonValue;
}

export interface ParticleSummary {
  file: string;
  identifier: string | null;
  texture: string | null;
  material: string | null;
  components: string[];
  blockbusterComponents: string[];
  error?: string;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  summary: ParticleSummary;
  texture?: TextureMetadata;
}

export interface TextureMetadata {
  path: string;
  bytes: number;
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  hasAlphaChannel: boolean;
  hasAlpha: boolean;
  nonZeroCoverage: number;
  brightCoverage: number;
  source: TextureSource;
  shadowedSources: TextureSource[];
}

export interface TextureSource {
  kind: "project" | "shared_bank";
  root: string;
  bankIndex?: number;
}

export interface TimelineLayer {
  helper: string;
  startTicks: number;
  startSeconds: number;
  selector: string | null;
  scheme: string | null;
  file: string | null;
  anchor: "caster_attached" | "fixed_at_helper_launch" | "non_emitter" | "unknown";
  helperDuration: number | null;
  emitterSeconds: number | null;
  particleSeconds: number | null;
  latestParticleEndSeconds: number | null;
  relativeOffset: string | null;
}
