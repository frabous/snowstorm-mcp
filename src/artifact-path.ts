import { randomUUID } from "node:crypto";
import path from "node:path";

export function artifactDirectoryPath(root: string, kind: string, prefix?: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uniqueId = randomUUID().slice(0, 8);
  const name = [prefix, timestamp, uniqueId].filter(Boolean).join("-");
  return path.join(root, kind, name);
}
