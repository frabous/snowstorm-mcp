import { spawn } from "node:child_process";

type StdoutMode = "ignore" | "text" | "binary";
type StderrMode = "bounded" | "tail";

interface ProcessCaptureOptions {
  cwd?: string;
  timeoutMs: number;
  stdoutMode: StdoutMode;
  stdoutLimitBytes: number;
  stderrMode: StderrMode;
  stderrLimitBytes: number;
  errorTailBytes: number;
}

interface ProcessCaptureResult {
  stdout: string | Buffer;
  stderr: string;
}

function executeProcess(command: string, args: string[], options: ProcessCaptureOptions): Promise<ProcessCaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", options.stdoutMode === "ignore" ? "ignore" : "pipe", "pipe"],
      windowsHide: true
    });
    let stdoutText = "";
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (failure?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (failure) {
        reject(failure);
        return;
      }
      resolve({
        stdout: options.stdoutMode === "binary" ? Buffer.concat(stdoutChunks) : stdoutText,
        stderr
      });
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`${command} exceeded the ${options.timeoutMs}ms process timeout.`));
    }, options.timeoutMs);

    if (options.stdoutMode !== "ignore") {
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > options.stdoutLimitBytes) {
          child.kill();
          const label = options.stdoutMode === "binary" ? " binary output" : " output";
          finish(new Error(`${command} exceeded the ${options.stdoutLimitBytes} byte${label} limit.`));
        } else if (options.stdoutMode === "binary") stdoutChunks.push(chunk);
        else stdoutText += chunk.toString();
      });
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (options.stderrMode === "tail") {
        stderr = `${stderr}${chunk.toString()}`.slice(-options.stderrLimitBytes);
        return;
      }
      const next = `${stderr}${chunk.toString()}`;
      if (Buffer.byteLength(next) > options.stderrLimitBytes) {
        child.kill();
        finish(new Error(`${command} exceeded the ${options.stderrLimitBytes} byte output limit.`));
      } else stderr = next;
    });

    child.once("error", (failure) => finish(failure));
    child.once("exit", (code) => code === 0
      ? finish()
      : finish(new Error(`${command} failed (${code}): ${stderr.slice(-options.errorTailBytes)}`)));
  });
}

export async function runFfmpeg(args: string[]): Promise<void> {
  await executeProcess("ffmpeg", ["-y", ...args], {
    timeoutMs: 120_000,
    stdoutMode: "ignore",
    stdoutLimitBytes: 0,
    stderrMode: "tail",
    stderrLimitBytes: 16_384,
    errorTailBytes: 1_000
  });
}

export async function runProcessText(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const result = await executeProcess(command, args, {
    cwd,
    timeoutMs: 120_000,
    stdoutMode: "text",
    stdoutLimitBytes: 4 * 1024 * 1024,
    stderrMode: "bounded",
    stderrLimitBytes: 4 * 1024 * 1024,
    errorTailBytes: 1_200
  });
  return result as { stdout: string; stderr: string };
}

export async function runProcessBinary(command: string, args: string[]): Promise<Buffer> {
  const result = await executeProcess(command, args, {
    timeoutMs: 120_000,
    stdoutMode: "binary",
    stdoutLimitBytes: 8 * 1024 * 1024,
    stderrMode: "tail",
    stderrLimitBytes: 16_384,
    errorTailBytes: 1_200
  });
  return result.stdout as Buffer;
}
