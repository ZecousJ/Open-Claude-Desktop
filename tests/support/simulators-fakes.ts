/** Stand-ins for the simulator tests: no device, no process, no Electron. */
import type { ImageScaler } from "../../electron/simulators/png";
import {
  CommandError,
  type RunOptions,
  type Runner,
  type RunningProcess,
} from "../../electron/simulators/runner";
import type { FileProbe } from "../../electron/simulators/toolchain";

/** A PNG header for a screen of this size (enough for `pngSize`). */
export function png(width: number, height: number) {
  const data = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

export type Reply = string | Buffer | Error | undefined;

/** Answers each command from a function and remembers what was run. */
export class FakeRunner implements Runner {
  calls: { file: string; args: string[]; options?: RunOptions }[] = [];
  detached: { file: string; args: string[] }[] = [];
  constructor(private respond: (file: string, args: string[]) => Reply) {}
  private answer(file: string, args: string[], options?: RunOptions) {
    this.calls.push({ file, args, options });
    const reply = this.respond(file, args);
    if (reply instanceof Error) throw reply;
    if (reply === undefined)
      throw new CommandError(`${file} ${args[0]} failed`, file, 1, "");
    return reply;
  }
  async run(file: string, args: string[], options?: RunOptions) {
    return String(this.answer(file, args, options));
  }
  async runBinary(file: string, args: string[], options?: RunOptions) {
    const reply = this.answer(file, args, options);
    return Buffer.isBuffer(reply) ? reply : Buffer.from(reply);
  }
  async startDetached(file: string, args: string[]) {
    this.detached.push({ file, args });
  }
  /** Processes `start` began, newest last; a test feeds and ends them. */
  started: FakeProcess[] = [];
  start(file: string, args: string[]) {
    this.calls.push({ file, args });
    const process = new FakeProcess(file, args);
    this.started.push(process);
    return process;
  }
  /** The runs of one tool, as "tool arg arg" lines. */
  lines(file?: string) {
    return this.calls
      .filter((call) => !file || call.file === file)
      .map((call) => `${call.file} ${call.args.join(" ")}`);
  }
}

/** A kept process: `emit` writes a line of output, `finish` ends it. */
export class FakeProcess implements RunningProcess {
  private listeners: ((line: string) => void)[] = [];
  private finished = false;
  private settle!: (value: {
    code: number | null;
    signal: string | null;
  }) => void;
  errors = "";
  signals: string[] = [];
  /** What a kill does: by default SIGINT and SIGTERM end the process. */
  onKill?: (signal: string) => void;
  exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => (this.settle = resolve),
  );
  constructor(
    readonly file: string,
    readonly args: string[],
  ) {}
  onLine(listener: (line: string) => void) {
    this.listeners.push(listener);
  }
  emit(line: string) {
    for (const listener of this.listeners) listener(line);
  }
  stderr() {
    return this.errors;
  }
  done() {
    return this.finished;
  }
  finish(code: number | null = 0, signal: string | null = null) {
    if (this.finished) return;
    this.finished = true;
    this.settle({ code, signal });
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    if (this.onKill) this.onKill(signal);
    else this.finish(null, signal);
  }
}

/** A file system of paths: a path ending in "/" is a folder with the listed children. */
export function fakeProbe(
  files: Record<string, string | string[] | true> = {},
): FileProbe {
  const has = (file: string) =>
    file in files ||
    Object.keys(files).some((key) => key.startsWith(`${file}/`));
  return {
    exists: async (file) => has(file),
    isDirectory: async (file) =>
      Array.isArray(files[file]) || (has(file) && !(file in files)),
    isFile: async (file) =>
      typeof files[file] === "string" || files[file] === true,
    list: async (folder) => {
      const entry = files[folder];
      if (Array.isArray(entry)) return entry;
      const prefix = `${folder}/`;
      return [
        ...new Set(
          Object.keys(files)
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length).split("/")[0]),
        ),
      ];
    },
    readText: async (file) =>
      typeof files[file] === "string" ? (files[file] as string) : undefined,
  };
}

/** Scales nothing: reports the size it was asked for. */
export const fakeScaler: ImageScaler = (data, size) => ({
  data: Buffer.from(`scaled:${data.length}`),
  mimeType: "image/jpeg",
  width: size.width,
  height: size.height,
});

export const iosList = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
      {
        udid: "11111111-1111-1111-1111-111111111111",
        name: "iPhone 16",
        state: "Shutdown",
        isAvailable: true,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      {
        udid: "22222222-2222-2222-2222-222222222222",
        name: "iPhone 18 Pro",
        state: "Shutdown",
        isAvailable: true,
      },
      {
        udid: "33333333-3333-3333-3333-333333333333",
        name: "iPhone 17",
        state: "Booted",
        isAvailable: true,
      },
      {
        udid: "44444444-4444-4444-4444-444444444444",
        name: "Broken",
        state: "Shutdown",
        isAvailable: false,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-12-0": [
      {
        udid: "55555555-5555-5555-5555-555555555555",
        name: "Apple Watch",
        state: "Shutdown",
        isAvailable: true,
      },
    ],
  },
});
