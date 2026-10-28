/**
 * The computer-use driver process (R10 design §3.1 DriverHost). Only the
 * main process starts the driver and holds its stdio: anything that can
 * write to it can operate the computer, so it is never handed to Codex or
 * put on a socket (docs/computer-use.md §4.4).
 *
 * The driver is an MCP server over stdio (one JSON object per line). It is
 * started on first use with the environment of the current mode
 * (Background or Full control: the driver reads it at start, so a mode
 * change restarts it), restarted after a crash, and stopped after five idle
 * minutes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ComputerUseToolResult } from "../../shared/computer-use";

export type DriverMode = "background" | "fullControl";

/** An app the driver lists. */
export interface DriverApp {
  name: string;
  /** macOS bundle id, Windows process name. */
  id: string;
  /** Windows: the process id the driver targets exactly. */
  pid?: number;
  running: boolean;
  frontmost: boolean;
}

/** What the broker needs from a driver, whichever one is installed. */
export interface ComputerDriver {
  /** Running and recently used apps (`mode`: the environment the driver runs in now). */
  listApps(mode: DriverMode): Promise<DriverApp[]>;
  /** Calls one of the driver's tools; `args.app` is already the exact target. */
  call(
    tool: string,
    args: Record<string, unknown>,
    mode: DriverMode,
  ): Promise<ComputerUseToolResult>;
  /** Ends the driver process (sign-out, quit, idle). */
  stop(): Promise<void>;
}

/** `manifest.json` that scripts/computer-use/fetch-driver.mjs writes. */
export interface DriverManifest {
  driver: string;
  version: string;
  platform: string;
  executable: string;
  executableSha256: string;
  args: string[];
  env: { base: Record<string, string>; fullControl: Record<string, string> };
  tools: string[];
}

/** The installed driver, or undefined when this build has none (or it doesn't match its manifest's platform). */
export function readDriverManifest(
  dir: string,
  platform: string = process.platform,
): (DriverManifest & { dir: string }) | undefined {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
    ) as DriverManifest;
    if (
      typeof manifest.executable !== "string" ||
      typeof manifest.executableSha256 !== "string" ||
      manifest.platform !== platform ||
      path.isAbsolute(manifest.executable) ||
      manifest.executable.split(/[\\/]/).includes("..")
    )
      return undefined;
    if (!fs.existsSync(path.join(dir, manifest.executable))) return undefined;
    return {
      ...manifest,
      args: Array.isArray(manifest.args) ? manifest.args : ["mcp"],
      env: {
        base: manifest.env?.base ?? {},
        fullControl: manifest.env?.fullControl ?? {},
      },
      tools: Array.isArray(manifest.tools) ? manifest.tools : [],
      dir,
    };
  } catch {
    return undefined;
  }
}

/** The environment a driver starts with in a mode: base, then the full-control overrides. */
export function driverEnv(
  manifest: Pick<DriverManifest, "env">,
  mode: DriverMode,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Only what a GUI helper needs; no API keys or tokens from the app's environment.
  for (const name of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "PSModulePath",
    "ComSpec",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
  ])
    if (inherited[name] !== undefined) env[name] = inherited[name];
  Object.assign(env, manifest.env.base);
  if (mode === "fullControl") Object.assign(env, manifest.env.fullControl);
  return env;
}

export type Spawner = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => ChildProcessWithoutNullStreams;

const defaultSpawner: Spawner = (command, args, env) =>
  spawn(command, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

interface Waiter {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** A line-delimited JSON-RPC client on a child's stdio (MCP stdio framing). */
export class McpStdioClient {
  private pending = new Map<number, Waiter>();
  private nextId = 1;
  private closed?: Error;
  stderr = "";
  constructor(private child: ChildProcessWithoutNullStreams) {
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.on("exit", (code, signal) =>
      this.fail(
        new Error(`The computer use driver stopped (${signal ?? code}).`),
      ),
    );
    child.on("error", (error) => this.fail(error));
    child.stdin.on("error", () => {});
  }
  private receive(line: string) {
    if (!line.trim()) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message?.id !== "number") return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error)
      waiter.reject(
        new Error(String(message.error.message ?? "The driver failed.")),
      );
    else waiter.resolve(message.result);
  }
  private fail(error: Error) {
    this.closed ??= error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
  get isClosed() {
    return Boolean(this.closed);
  }
  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The computer use driver didn't answer ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }
  notify(method: string, params?: unknown) {
    if (!this.closed)
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`,
      );
  }
}

export interface DriverHostOptions {
  manifest: DriverManifest & { dir: string };
  spawner?: Spawner;
  /** Stop the driver after this long without a call. */
  idleMs?: number;
  callTimeoutMs?: number;
  /** Check the executable against the manifest before the first start (off in tests). */
  verify?: boolean;
}

/**
 * Starts, restarts and stops the driver process and sends it tool calls.
 * Calls are sent one at a time (the broker queues them too).
 */
export class DriverHost {
  private child?: ChildProcessWithoutNullStreams;
  private client?: McpStdioClient;
  private mode?: DriverMode;
  private starting?: Promise<McpStdioClient>;
  private idleTimer?: NodeJS.Timeout;
  private verified = false;
  private crashes: number[] = [];
  constructor(private options: DriverHostOptions) {}

  private get executable() {
    return path.join(
      this.options.manifest.dir,
      this.options.manifest.executable,
    );
  }

  private verify() {
    if (this.verified || this.options.verify === false) return;
    const hash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(this.executable))
      .digest("hex");
    if (hash !== this.options.manifest.executableSha256)
      throw new Error(
        "The computer use driver in this installation was changed. Reinstall Claudex.",
      );
    this.verified = true;
  }

  private async start(mode: DriverMode): Promise<McpStdioClient> {
    const recent = this.crashes.filter((at) => Date.now() - at < 60_000);
    this.crashes = recent;
    if (recent.length >= 3)
      throw new Error(
        "The computer use driver keeps stopping. Try again in a minute.",
      );
    this.verify();
    const child = (this.options.spawner ?? defaultSpawner)(
      this.executable,
      this.options.manifest.args,
      driverEnv(this.options.manifest, mode),
    );
    const client = new McpStdioClient(child);
    child.on("exit", () => {
      // stop() forgets the child first, so only an unexpected exit counts.
      if (this.child === child) {
        this.crashes.push(Date.now());
        this.child = undefined;
        this.client = undefined;
        this.mode = undefined;
      }
    });
    this.child = child;
    this.client = client;
    this.mode = mode;
    await client.request(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "claudex", version: "1" },
      },
      20_000,
    );
    client.notify("notifications/initialized");
    return client;
  }

  private async ready(mode: DriverMode) {
    if (this.starting) await this.starting.catch(() => {});
    if (this.client && !this.client.isClosed && this.mode === mode)
      return this.client;
    if (this.child) await this.stop();
    this.starting = this.start(mode);
    try {
      return await this.starting;
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      this.starting = undefined;
    }
  }

  private inFlight = 0;

  /** Arms the idle stop once no call is running. */
  private touch() {
    clearTimeout(this.idleTimer);
    if (this.inFlight) return;
    this.idleTimer = setTimeout(
      () => void this.stop(),
      this.options.idleMs ?? 5 * 60_000,
    );
    this.idleTimer.unref?.();
  }

  /** Sends one MCP request to the driver in `mode`, starting it if needed. */
  async request(method: string, params: unknown, mode: DriverMode) {
    this.inFlight++;
    clearTimeout(this.idleTimer);
    try {
      const client = await this.ready(mode);
      return await client.request(
        method,
        params,
        this.options.callTimeoutMs ?? 90_000,
      );
    } finally {
      this.inFlight--;
      this.touch();
    }
  }

  /** Whether the driver process is running. */
  get running() {
    return Boolean(this.child);
  }

  async stop() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = undefined;
    this.client = undefined;
    this.mode = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2000);
    await exited;
    clearTimeout(timer);
  }
}
