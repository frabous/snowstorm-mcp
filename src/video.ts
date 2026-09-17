import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { requireResolvedPathInside } from "./config.js";
import type { ProjectConfig } from "./types.js";

const videoExtensions = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"]);

export interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number | null;
  format: string | null;
}

export interface VideoFrame {
  index: number;
  requestedSeconds: number;
  requestedTimecode: string;
  actualSeconds: number | null;
  actualTimecode: string | null;
  path: string;
}

export interface VideoAnalysis {
  source: string;
  metadata: VideoMetadata;
  sceneTimes: number[];
  frames: VideoFrame[];
  contactSheet: string;
  manifest: string;
}

function run(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} failed (${code}): ${stderr.slice(-1200)}`)));
  });
}

function ratio(value: string | undefined): number | null {
  if (!value || value === "0/0") return null;
  const [numerator, denominator] = value.split("/", 2).map(Number);
  return denominator ? numerator / denominator : null;
}

export function formatTimecode(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

export function parseTimecode(value: string | number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") throw new Error("Timecode must be seconds or HH:MM:SS.mmm.");
  const match = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2}(?:\.\d{1,3})?)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid timecode: ${value}`);
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds >= 60) throw new Error(`Invalid timecode: ${value}`);
  return hours * 3600 + minutes * 60 + seconds;
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "reference";
}

export class VideoAnalyzer {
  constructor(private readonly config: ProjectConfig) {}

  resolve(file: string): string {
    if (!videoExtensions.has(path.extname(file).toLowerCase())) throw new Error(`Unsupported video extension: ${file}`);
    return requireResolvedPathInside(this.config.referenceVideosRoot, file);
  }

  async list(): Promise<string[]> {
    const output: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile() && videoExtensions.has(path.extname(entry.name).toLowerCase())) output.push(path.relative(this.config.referenceVideosRoot, target).replaceAll(path.sep, "/"));
      }
    };
    await walk(this.config.referenceVideosRoot);
    return output.sort();
  }

  async probe(file: string): Promise<VideoMetadata> {
    const source = this.resolve(file);
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration,format_name", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,duration", "-of", "json", source]);
    const data = JSON.parse(stdout) as { format?: { duration?: string; format_name?: string }; streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; duration?: string }> };
    const stream = data.streams?.[0];
    const durationSeconds = Number(data.format?.duration ?? stream?.duration);
    if (!stream || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`No usable video stream in ${file}.`);
    if (durationSeconds > 600) throw new Error("Reference videos are limited to 10 minutes. Trim the relevant VFX sequence before analysis.");
    return { durationSeconds, width: stream.width ?? 0, height: stream.height ?? 0, fps: ratio(stream.avg_frame_rate) ?? ratio(stream.r_frame_rate), format: data.format?.format_name ?? null };
  }

  async analyze(file: string, options: { samples?: number; sceneThreshold?: number } = {}): Promise<VideoAnalysis> {
    const metadata = await this.probe(file);
    const source = this.resolve(file);
    const samples = Math.min(24, Math.max(4, options.samples ?? 12));
    const threshold = Math.min(1, Math.max(0.05, options.sceneThreshold ?? 0.3));
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", source, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"]);
    const sceneTimes = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite).slice(0, samples);
    const end = Math.max(0, metadata.durationSeconds - 1 / (metadata.fps ?? 30));
    const evenTimes = Array.from({ length: samples }, (_, index) => end * index / Math.max(1, samples - 1));
    const selected = [...new Set([...sceneTimes, ...evenTimes].map((time) => Math.min(end, Math.max(0, time)).toFixed(3)))].map(Number).sort((a, b) => a - b).slice(0, samples);
    const artifactDirectory = path.join(this.config.artifactsRoot, "video", `${slug(path.basename(file, path.extname(file)))}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
    const frames = await this.extract(source, selected, artifactDirectory);
    const contactSheet = await this.createContactSheet(frames, artifactDirectory);
    const manifest = path.join(artifactDirectory, "manifest.json");
    const analysis: VideoAnalysis = { source, metadata, sceneTimes, frames, contactSheet, manifest };
    await writeFile(manifest, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
    return analysis;
  }

  async extractAtTimecodes(file: string, timecodes: Array<string | number>): Promise<{ metadata: VideoMetadata; frames: VideoFrame[]; contactSheet: string; manifest: string }> {
    const metadata = await this.probe(file);
    const source = this.resolve(file);
    const times = timecodes.map((timecode) => Math.round(parseTimecode(timecode) * 1000) / 1000);
    if (times.length === 0 || times.length > 24) throw new Error("Provide between 1 and 24 timecodes.");
    if (times.some((time) => time >= metadata.durationSeconds)) throw new Error(`A requested timecode must be before the ${formatTimecode(metadata.durationSeconds)} video end.`);
    const artifactDirectory = path.join(this.config.artifactsRoot, "video", `${slug(path.basename(file, path.extname(file)))}-precise-${randomUUID().slice(0, 8)}`);
    const frames = await this.extract(source, times, artifactDirectory);
    const contactSheet = await this.createContactSheet(frames, artifactDirectory);
    const manifest = path.join(artifactDirectory, "manifest.json");
    const result = { metadata, frames, contactSheet, manifest };
    await writeFile(manifest, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  }

  private async extract(source: string, times: number[], artifactDirectory: string): Promise<VideoFrame[]> {
    await mkdir(artifactDirectory, { recursive: true });
    const frames: VideoFrame[] = [];
    for (const [index, seconds] of times.entries()) {
      const temporary = path.join(artifactDirectory, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
      // Seeking after input decodes from the target, avoiding keyframe-only extraction.
      const { stderr } = await run("ffmpeg", ["-hide_banner", "-y", "-i", source, "-ss", seconds.toFixed(3), "-vf", "showinfo", "-frames:v", "1", "-q:v", "2", temporary]);
      const decodedTimes = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
      const actualSeconds = decodedTimes.at(-1) ?? null;
      const actualTimecode = actualSeconds === null ? null : formatTimecode(actualSeconds);
      const filename = `frame-${String(index + 1).padStart(2, "0")}-${(actualTimecode ?? formatTimecode(seconds)).replaceAll(":", "-")}.jpg`;
      const output = path.join(artifactDirectory, filename);
      await rename(temporary, output);
      frames.push({ index: index + 1, requestedSeconds: seconds, requestedTimecode: formatTimecode(seconds), actualSeconds, actualTimecode, path: output });
    }
    return frames;
  }

  private async createContactSheet(frames: VideoFrame[], artifactDirectory: string): Promise<string> {
    const list = path.join(artifactDirectory, "frames.txt");
    await writeFile(list, frames.map((frame) => `file '${path.basename(frame.path).replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
    const columns = Math.ceil(Math.sqrt(frames.length));
    const rows = Math.ceil(frames.length / columns);
    const contactSheet = path.join(artifactDirectory, "contact-sheet.jpg");
    await run("ffmpeg", ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", "frames.txt", "-vf", `scale=320:-1,tile=${columns}x${rows}:padding=8:margin=8`, "-frames:v", "1", "-q:v", "2", "contact-sheet.jpg"], artifactDirectory);
    return contactSheet;
  }
}
