export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ProjectConfig {
  configPath: string;
  projectName: string;
  particlesRoot: string;
  resourcePackRoot: string;
  selectorsFile: string;
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
}
