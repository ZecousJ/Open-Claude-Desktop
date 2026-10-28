/**
 * Runs the tools that talk to simulators and emulators (`xcrun`, `adb`,
 * `emulator`, `idb`). Every call is an `execFile` with an argument array:
 * there is never a shell, so nothing a device name, an app path or the
 * model's text says can become a command. The drivers take a `Runner`, so
 * their tests run without a device.
 */
import { execFile, spawn } from "node:child_process";

export interface RunOptions {
  /** Milliseconds before the process is killed (default 30 s). */
  timeoutMs?: number;
  /** Extra environment for the process. */
  env?: Record<string, string>;
  /** Text written to the process's standard input (`simctl pbcopy`). */
  input?: string;
}

/** A failed run: the exit code (or the system error code) and what the tool said. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly code: number | string | undefined,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
  /** The tool is not installed. */
  get missing() {
    return this.code === "ENOENT";
  }
}

/** A process `Runner.start` began. */
export interface RunningProcess {
  /** Each line of standard output, without its line break. */
  onLine(listener: (line: string) => void): void;
  /** Standard error so far (the first 4 KB). */
  stderr(): string;
  /** Settles once the process has ended (or could not start). */
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** Whether it has ended. */
  done(): boolean;
  kill(signal?: NodeJS.Signals): void;
}

export interface Runner {
  /** The tool's standard output as text; throws a CommandError on failure. */
  run(file: string, args: string[], options?: RunOptions): Promise<string>;
  /** The tool's standard output as bytes (a screenshot). */
  runBinary(
    file: string,
    args: string[],
    options?: RunOptions,
  ): Promise<Buffer>;
  /** Starts a long-running process (an emulator) and lets it go on without us. */
  startDetached(file: string, args: string[]): Promise<void>;
  /**
   * Starts a process the app keeps hold of (a screen recording, a log
   * stream): its output arrives line by line until it ends or is stopped.
   */
  start(file: string, args: string[]): RunningProcess;
}

const defaultTimeout = 30_000;
/** A 4K phone screenshot as PNG is a few MB. */
const maxBuffer = 64 * 1024 * 1024;

function failure(
  file: string,
  args: string[],
  error: NodeJS.ErrnoException & { killed?: boolean },
  stderr: string,
) {
  const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  const what = error.killed
    ? "timed out"
    : error.code === "ENOENT"
      ? "is not installed"
      : `failed${detail ? `: ${detail}` : ""}`;
  return new CommandError(
    `${file} ${args[0] ?? ""} ${what}`.replace(/\s+/g, " ").trim(),
    file,
    error.code,
    stderr,
  );
}

function execute(
  file: string,
  args: string[],
  options: RunOptions,
  encoding: "utf8" | "buffer",
): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        timeout: options.timeoutMs ?? defaultTimeout,
        maxBuffer,
        windowsHide: true,
        encoding: encoding === "buffer" ? "buffer" : "utf8",
        env: { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            failure(
              file,
              args,
              error as NodeJS.ErrnoException,
              String(stderr ?? ""),
            ),
          );
        else resolve(stdout);
      },
    );
    if (options.input !== undefined) {
      // A tool that exits before reading its input is not an error here.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
  });
}

/** `promise`'s value, or `fallback` once `ms` have passed (the timer is cleared either way). */
export function within<T, F>(
  promise: Promise<T>,
  ms: number,
  fallback: F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<F>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** How much of a kept process's standard error is remembered. */
const stderrLimit = 4096;
/** A line longer than this is cut rather than kept growing. */
const lineLimit = 65_536;

/** Splits a stream of text into lines (a partial last line waits for the rest). */
export function lineSplitter(listener: (line: string) => void) {
  let partial = "";
  return {
    push(chunk: string) {
      const lines = (partial + chunk).split("\n");
      partial = (lines.pop() ?? "").slice(0, lineLimit);
      for (const line of lines) listener(line.replace(/\r$/, ""));
    },
    end() {
      if (partial) listener(partial.replace(/\r$/, ""));
      partial = "";
    },
  };
}

function startProcess(file: string, args: string[]): RunningProcess {
  const child = spawn(file, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const listeners: ((line: string) => void)[] = [];
  const lines = lineSplitter((line) => {
    for (const listener of listeners) listener(line);
  });
  let errors = "";
  let ended = false;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => lines.push(chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (errors.length < stderrLimit)
      errors = (errors + chunk).slice(0, stderrLimit);
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.once("error", (error) => {
        ended = true;
        errors ||= error.message;
        resolve({ code: null, signal: null });
      });
      child.once("close", (code, signal) => {
        ended = true;
        lines.end();
        resolve({ code, signal });
      });
    },
  );
  return {
    onLine: (listener) => void listeners.push(listener),
    stderr: () => errors,
    exited,
    done: () => ended,
    kill(signal = "SIGTERM") {
      if (ended) return;
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    },
  };
}

/** The runner the app uses. */
export const systemRunner: Runner = {
  async run(file, args, options = {}) {
    return (await execute(file, args, options, "utf8")) as string;
  },
  async runBinary(file, args, options = {}) {
    return (await execute(file, args, options, "buffer")) as Buffer;
  },
  startDetached(file, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", (error) =>
        reject(
          failure(file, args, error as NodeJS.ErrnoException, String(error)),
        ),
      );
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  },
  start: startProcess,
};
