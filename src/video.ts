import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
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

export interface AudioTransient {
  seconds: number;
  strength: number;
}

export interface AudioTransientAnalysis {
  source: string;
  startSeconds: number;
  durationSeconds: number;
  sampleRate: number;
  frameSize: number;
  hopSamples: number;
  highPassHz: number;
  method: string;
  transients: AudioTransient[];
  caveat: string;
}

export interface VideoComparison {
  reference: string;
  preview: string;
  referenceStartSeconds: number;
  durationSeconds: number;
  panelWidth: number;
  panelHeight: number;
  output: string;
  audio: "reference";
}

interface MediaProbe {
  metadata: VideoMetadata;
  audio: { startSeconds: number; durationSeconds: number } | null;
}

const MAX_PROCESS_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const MAX_COMPARISON_RENDERED_PIXELS = 480_000_000;

function run(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (failure?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      failure ? reject(failure) : resolve({ stdout, stderr });
    };
    const append = (current: string, chunk: Buffer): string | undefined => {
      const next = current + chunk.toString();
      return Buffer.byteLength(next) > MAX_PROCESS_TEXT_BYTES ? undefined : next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const next = append(stdout, chunk);
      if (next === undefined) {
        child.kill();
        finish(new Error(`${command} exceeded the ${MAX_PROCESS_TEXT_BYTES} byte output limit.`));
      } else stdout = next;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = append(stderr, chunk);
      if (next === undefined) {
        child.kill();
        finish(new Error(`${command} exceeded the ${MAX_PROCESS_TEXT_BYTES} byte output limit.`));
      } else stderr = next;
    });
    timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`${command} exceeded the 120000ms process timeout.`));
    }, 120_000);
    child.once("error", (failure) => finish(failure));
    child.once("exit", (code) => code === 0 ? finish() : finish(new Error(`${command} failed (${code}): ${stderr.slice(-1200)}`)));
  });
}

function runBinary(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let error = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (failure?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      failure ? reject(failure) : resolve(Buffer.concat(output));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_AUDIO_BYTES) {
        child.kill();
        finish(new Error(`${command} exceeded the ${MAX_AUDIO_BYTES} byte binary output limit.`));
      } else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { error = `${error}${chunk.toString()}`.slice(-16_384); });
    timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`${command} exceeded the 120000ms process timeout.`));
    }, 120_000);
    child.once("error", (failure) => finish(failure));
    child.once("exit", (code) => code === 0 ? finish() : finish(new Error(`${command} failed (${code}): ${error.slice(-1200)}`)));
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

export function comparisonFilter(panelWidth: number, panelHeight: number): string {
  const panel = `scale=${panelWidth}:${panelHeight}:force_original_aspect_ratio=decrease,pad=${panelWidth}:${panelHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  return `[0:v]setpts=PTS-STARTPTS,${panel}[left];[1:v]setpts=PTS-STARTPTS,${panel}[right];[left][right]hstack=inputs=2[v]`;
}

export function enforceComparisonBudget(durationSeconds: number, panelWidth: number, panelHeight: number): void {
  const renderedPixels = Math.ceil(durationSeconds * 24) * panelWidth * 2 * panelHeight;
  if (renderedPixels > MAX_COMPARISON_RENDERED_PIXELS) {
    throw new Error(`Comparison exceeds the ${MAX_COMPARISON_RENDERED_PIXELS.toLocaleString("en-US")} rendered-pixel budget. Lower panel size or duration.`);
  }
}

export function previewReportPath(previewPath: string): string | null {
  const directory = path.dirname(previewPath);
  const kind = path.basename(path.dirname(directory));
  const filename = path.basename(previewPath);
  if (kind === "scenes" && filename === "scene.mp4") return path.join(directory, "report.json");
  if (kind === "renders" && filename === "preview.mp4") return path.join(directory, "report.json");
  return null;
}

export function audioCoverage(stream: { start_time?: string; duration?: string } | undefined, containerDurationSeconds: number): { startSeconds: number; durationSeconds: number } | null {
  const startSeconds = Number(stream?.start_time ?? 0);
  const streamDuration = Number(stream?.duration);
  const durationSeconds = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : containerDurationSeconds;
  return Number.isFinite(startSeconds) && Number.isFinite(durationSeconds) && durationSeconds > 0 ? { startSeconds, durationSeconds } : null;
}

export function rankAudioTransients(scores: readonly number[], options: {
  startSeconds: number;
  hopSamples: number;
  frameSize: number;
  sampleRate: number;
  maxResults: number;
  minimumSpacingSeconds: number;
}): AudioTransient[] {
  const candidates = scores
    .map((strength, index) => ({
      seconds: options.startSeconds + (index * options.hopSamples + options.frameSize / 2) / options.sampleRate,
      strength
    }))
    .filter((candidate) => Number.isFinite(candidate.strength) && candidate.strength > 0)
    .sort((left, right) => right.strength - left.strength);
  const selected: AudioTransient[] = [];
  for (const candidate of candidates) {
    if (selected.every((entry) => Math.abs(entry.seconds - candidate.seconds) >= options.minimumSpacingSeconds)) {
      selected.push({ seconds: Number(candidate.seconds.toFixed(4)), strength: Number(candidate.strength.toFixed(5)) });
      if (selected.length === options.maxResults) break;
    }
  }
  return selected.sort((left, right) => left.seconds - right.seconds);
}

function highPassAttackScores(samples: Float32Array, sampleRate: number, highPassHz: number): { frameSize: number; hopSamples: number; scores: number[] } {
  const frameSize = 1024;
  const hopSamples = 120;
  const alpha = 1 / (1 + 2 * Math.PI * highPassHz / sampleRate);
  const filtered = new Float32Array(samples.length);
  let previousInput = 0;
  let previousOutput = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const input = samples[index]!;
    const output = alpha * (previousOutput + input - previousInput);
    filtered[index] = output;
    previousInput = input;
    previousOutput = output;
  }
  const scores: number[] = [];
  let previousLogEnergy: number | undefined;
  for (let start = 0; start + frameSize <= filtered.length; start += hopSamples) {
    let energy = 0;
    for (let index = 0; index < frameSize; index += 1) {
      const sample = filtered[start + index]!;
      energy += sample * sample;
    }
    const logEnergy = Math.log(Math.max(energy / frameSize, 1e-12));
    scores.push(previousLogEnergy === undefined ? 0 : Math.max(0, logEnergy - previousLogEnergy));
    previousLogEnergy = logEnergy;
  }
  return { frameSize, hopSamples, scores };
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

  async import(sourcePath: string, name?: string): Promise<{ file: string; path: string; bytes: number }> {
    const requestedSource = path.resolve(sourcePath);
    const source = await realpath(requestedSource);
    const metadata = await stat(source);
    if (!metadata.isFile()) throw new Error(`Video source is not a file: ${sourcePath}`);
    if (!videoExtensions.has(path.extname(source).toLowerCase())) throw new Error(`Unsupported video extension: ${sourcePath}`);
    if (metadata.size > 4 * 1024 * 1024 * 1024) throw new Error("Reference videos are limited to 4 GB. Trim the VFX sequence before importing.");
    const extension = path.extname(source).toLowerCase();
    const base = name ? slug(path.basename(name, path.extname(name))) : slug(path.basename(source, path.extname(source)));
    for (let index = 0; index < 100; index += 1) {
      const filename = `${base}${index ? `-${index + 1}` : ""}${extension}`;
      const target = requireResolvedPathInside(this.config.referenceVideosRoot, filename);
      try {
        await copyFile(source, target, constants.COPYFILE_EXCL);
        return { file: filename, path: target, bytes: metadata.size };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("Could not allocate a unique filename for the imported video.");
  }

  async probe(file: string): Promise<VideoMetadata> {
    const source = this.resolve(file);
    return (await this.probePath(source, file)).metadata;
  }

  async audioTransients(file: string, options: {
    startSeconds: number;
    durationSeconds: number;
    maxResults: number;
    minimumSpacingSeconds: number;
    highPassHz: number;
  }): Promise<AudioTransientAnalysis> {
    const source = this.resolve(file);
    const media = await this.probePath(source, file);
    this.requireAudioWindow(media, options.startSeconds, options.durationSeconds, file);
    if (options.startSeconds + options.durationSeconds > media.metadata.durationSeconds) {
      throw new Error(`Audio window must end before the ${formatTimecode(media.metadata.durationSeconds)} video end.`);
    }
    const sampleRate = 24_000;
    const raw = await runBinary("ffmpeg", [
      "-hide_banner", "-nostdin", "-v", "error", "-ss", options.startSeconds.toFixed(3), "-i", source,
      "-t", options.durationSeconds.toFixed(3), "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1"
    ]);
    if (raw.length < 1024 * Float32Array.BYTES_PER_ELEMENT || raw.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error(`Could not decode enough audio for transient analysis: ${file}`);
    }
    const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    if (samples.length / sampleRate + 0.05 < options.durationSeconds) {
      throw new Error(`Decoded audio does not cover the requested ${options.durationSeconds.toFixed(3)} second window: ${file}`);
    }
    const { frameSize, hopSamples, scores } = highPassAttackScores(samples, sampleRate, options.highPassHz);
    return {
      source,
      startSeconds: options.startSeconds,
      durationSeconds: options.durationSeconds,
      sampleRate,
      frameSize,
      hopSamples,
      highPassHz: options.highPassHz,
      method: "Positive log high-pass short-time-energy change; 1,024-sample frames and 5 ms hops.",
      transients: rankAudioTransients(scores, { ...options, frameSize, hopSamples, sampleRate }),
      caveat: "Candidates come from the mixed soundtrack. They do not identify isolated sound effects and need listening confirmation."
    };
  }

  async compare(file: string, options: {
    previewPath: string;
    referenceStartSeconds: number;
    durationSeconds: number;
    panelWidth: number;
    panelHeight: number;
  }): Promise<VideoComparison> {
    enforceComparisonBudget(options.durationSeconds, options.panelWidth, options.panelHeight);
    const reference = this.resolve(file);
    const referenceMedia = await this.probePath(reference, file);
    this.requireAudioWindow(referenceMedia, options.referenceStartSeconds, options.durationSeconds, file);
    if (options.referenceStartSeconds + options.durationSeconds > referenceMedia.metadata.durationSeconds) {
      throw new Error(`Comparison window must end before the ${formatTimecode(referenceMedia.metadata.durationSeconds)} video end.`);
    }
    const preview = requireResolvedPathInside(this.config.artifactsRoot, options.previewPath);
    if (path.extname(preview).toLowerCase() !== ".mp4") throw new Error("previewPath must be an MCP-generated .mp4 artifact.");
    if (!(await stat(preview)).isFile()) throw new Error(`Preview artifact is not a file: ${options.previewPath}`);
    const reportPath = previewReportPath(preview);
    if (!reportPath) throw new Error("previewPath must be a scene.mp4 or preview.mp4 inside an MCP render artifact directory.");
    let report: { artifacts?: { animation?: string }; animation?: string };
    try {
      report = JSON.parse(await readFile(reportPath, "utf8")) as { artifacts?: { animation?: string }; animation?: string };
    } catch {
      throw new Error(`Preview artifact report is missing or unreadable: ${reportPath}`);
    }
    if (report.artifacts?.animation !== preview && report.animation !== preview) {
      throw new Error(`Preview artifact report does not register this animation: ${options.previewPath}`);
    }
    const previewMedia = await this.probePath(preview, "Preview artifact");
    if (previewMedia.metadata.durationSeconds + 0.05 < options.durationSeconds) {
      throw new Error(`Preview is shorter than the requested ${options.durationSeconds.toFixed(3)} second comparison.`);
    }
    const artifactDirectory = path.join(this.config.artifactsRoot, "comparisons", `${slug(path.basename(file, path.extname(file)))}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
    await mkdir(artifactDirectory, { recursive: true });
    const output = path.join(artifactDirectory, "comparison.mp4");
    let completed = false;
    try {
      await run("ffmpeg", [
        "-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", options.referenceStartSeconds.toFixed(3), "-i", reference, "-i", preview,
        "-filter_complex", comparisonFilter(options.panelWidth, options.panelHeight),
        "-map", "[v]", "-map", "0:a:0", "-t", options.durationSeconds.toFixed(3), "-r", "24",
        "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output
      ]);
      const outputMedia = await this.probePath(output, "Comparison output");
      if (Math.abs(outputMedia.metadata.durationSeconds - options.durationSeconds) > 0.05) {
        throw new Error(`Comparison output duration ${outputMedia.metadata.durationSeconds.toFixed(3)} does not match ${options.durationSeconds.toFixed(3)} seconds.`);
      }
      this.requireAudioWindow(outputMedia, 0, options.durationSeconds, "Comparison output");
      completed = true;
      return {
        reference,
        preview,
        referenceStartSeconds: options.referenceStartSeconds,
        durationSeconds: options.durationSeconds,
        panelWidth: options.panelWidth,
        panelHeight: options.panelHeight,
        output,
        audio: "reference"
      };
    } finally {
      if (!completed) await rm(artifactDirectory, { recursive: true, force: true });
    }
  }

  private async probePath(source: string, label: string): Promise<MediaProbe> {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,r_frame_rate,start_time,duration", "-of", "json", source]);
    const data = JSON.parse(stdout) as { format?: { duration?: string; format_name?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; start_time?: string; duration?: string }> };
    const stream = data.streams?.find((entry) => entry.codec_type === "video");
    const durationSeconds = Number(data.format?.duration ?? stream?.duration);
    if (!stream || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`No usable video stream in ${label}.`);
    if (durationSeconds > 600) throw new Error("Reference videos are limited to 10 minutes. Trim the relevant VFX sequence before analysis.");
    return {
      metadata: { durationSeconds, width: stream.width ?? 0, height: stream.height ?? 0, fps: ratio(stream.avg_frame_rate) ?? ratio(stream.r_frame_rate), format: data.format?.format_name ?? null },
      audio: audioCoverage(data.streams?.find((entry) => entry.codec_type === "audio"), durationSeconds)
    };
  }

  private requireAudioWindow(media: MediaProbe, startSeconds: number, durationSeconds: number, label: string): void {
    if (!media.audio) throw new Error(`Reference audio stream is missing or has no bounded duration: ${label}`);
    const audioEnd = media.audio.startSeconds + media.audio.durationSeconds;
    if (startSeconds < media.audio.startSeconds - 0.05 || startSeconds + durationSeconds > audioEnd + 0.05) {
      throw new Error(`Requested window is outside the ${formatTimecode(media.audio.startSeconds)}-${formatTimecode(audioEnd)} audio coverage: ${label}`);
    }
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
