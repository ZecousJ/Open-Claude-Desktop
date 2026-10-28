/**
 * Dev servers of a Code session's folder (R8-B): the configurations in
 * `.claude/launch.json` (read-only fallback `.claudex/launch.json`), Detect
 * dev server, starting a configuration and waiting for its port, its logs,
 * stopping it, and local addresses printed in the session's Terminal.
 *
 * Starting runs a program on this computer outside Claude's sandbox, so:
 *
 * - each different command (folder, executable, arguments, variables) is
 *   approved once per session: by the person in the panel, or through the
 *   approval Claude's Browser tools ask for (package R8-C passes `approve`);
 *   a server that crashes or fails to start asks again;
 * - Claude can't start a dev server while a scheduled task runs the session
 *   (nobody is there to approve);
 * - the command never goes through a shell, its folder must stay inside the
 *   session's folder (symbolic links resolved), and the app's tokens and
 *   keys are removed from its environment;
 * - every server stops when its session is deleted, at sign-out and when
 *   the app quits.
 *
 * No Electron imports: tests run it under node with stand-ins.
 */
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import fs from "node:fs";
import type { DevServerState, DevServerStatus } from "../../shared/browser";
import {
  launchCommandKey,
  launchAutoVerify,
  type LaunchEntry,
  type LaunchParseResult,
} from "../../shared/launch-config";
import type { AppEvent } from "../../shared/types";
import {
  defaultTiming,
  LogBuffer,
  localPortOpen,
  defaultKill,
  lower,
} from "./dev-server-support";
import * as devServersConfig from "./dev-servers-config";
import { installMethods } from "./install-methods";
import * as devServersRun from "./dev-servers-run";
import * as devServersWatch from "./dev-servers-watch";

/** Who asked to start a server. */
export type DevServerStarter = "person" | "claude";

/** What a person approves before a command runs (shown on Claude's approval card). */
export interface DevServerApprovalRequest {
  conversationId: string;
  name: string;
  /** "npm run dev", for showing. */
  command: string;
  executable: string;
  args: string[];
  /** The folder it runs in (absolute). */
  folder: string;
  port?: number;
  url?: string;
  /** Names of the variables launch.json sets (values are not shown). */
  envNames: string[];
}

export interface DevServerStartOptions {
  /**
   * "person" (default): the person confirmed in the panel, which approves the
   * command for the session. "claude": a Browser tool; an unapproved command
   * asks `approve`, and scheduled runs are refused.
   */
  by?: DevServerStarter;
  /** Asks the person (Claude's approval card); resolves true when allowed. */
  approve?: (request: DevServerApprovalRequest) => Promise<boolean>;
}

/** What the dev servers need to know about a conversation. */
export interface DevServerConversation {
  /** The session's folder on this computer. */
  cwd?: string;
  /** The session runs on another computer (SSH, R9): no local dev servers. */
  remote?: boolean;
}

export interface DevServersDeps {
  /** The conversation, or undefined once it was deleted. */
  conversation(conversationId: string): DevServerConversation | undefined;
  /** True while a scheduled task runs the conversation (`Scheduler.isUnattended`). */
  unattended(conversationId: string): boolean;
  /** The administrator allows dev servers (policy `browser.devServers`). */
  allowed(): boolean;
  beforeStart?(conversationId: string, name: string): Promise<void>;
  /** App events, for local addresses printed in the Terminal panel. */
  onEvent?(cb: (event: AppEvent) => void): () => void;
  platform?: NodeJS.Platform;
  /** The app's environment (default `process.env`); secrets are removed. */
  env?: NodeJS.ProcessEnv;
  /** PATH of the person's login shell (default: asks the shell once). */
  shellPath?: () => Promise<string | undefined>;
  spawn?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  /** Whether something accepts connections on the local port. */
  portOpen?: (port: number) => Promise<boolean>;
  /** Ends a process group (default: signals, taskkill on Windows). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  timing?: Partial<DevServerTiming>;
}

export interface DevServerTiming {
  /** Longest wait for the port after starting. */
  portTimeoutMs: number;
  pollMs: number;
  /** SIGTERM, then SIGKILL after this long. */
  killGraceMs: number;
  /** How often deleted conversations are looked for. */
  sweepMs: number;
  /** How often addresses printed in a terminal are checked again. */
  detectedRecheckMs: number;
}

export interface ServerRecord {
  conversationId: string;
  /** The configuration name as written. */
  name: string;
  entry: LaunchEntry;
  key: string;
  status: DevServerStatus;
  child?: ChildProcess;
  pid?: number;
  startedAt?: number;
  error?: string;
  url?: string;
  port?: number;
  logs: LogBuffer;
  stopping?: boolean;
  exited?: Promise<void>;
  starting?: Promise<DevServerState>;
}

export interface ConfigCache {
  file?: string;
  stamp?: string;
  result: LaunchParseResult;
  /** The folder's own problem (missing, remote), before any file. */
  folderError?: string;
}

interface DetectedUrl {
  url: string;
  port: number;
  terminals: Set<string>;
  open: boolean;
}

/** The dev servers of every Code session of the signed-in account. */
export class DevServers {
  readonly deps: DevServersDeps;
  readonly timing: DevServerTiming;
  readonly platform: NodeJS.Platform;
  readonly records = new Map<string, Map<string, ServerRecord>>();
  /** Approved command keys, per conversation (this run of the app only). */
  readonly approvals = new Map<string, Set<string>>();
  readonly configs = new Map<string, ConfigCache>();
  private readonly listeners = new Set<(conversationId: string) => void>();
  readonly detected = new Map<string, Map<string, DetectedUrl>>();
  readonly terminalTail = new Map<string, string>();
  readonly watchers = new Map<string, fs.FSWatcher>();
  readonly spawnProcess: NonNullable<DevServersDeps["spawn"]>;
  readonly portOpen: (port: number) => Promise<boolean>;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly offEvents?: () => void;
  private readonly sweeper: ReturnType<typeof setInterval>;
  recheck?: ReturnType<typeof setInterval>;
  disposed = false;
  private readonly onExit = () => this.killAllNow();

  constructor(deps: DevServersDeps) {
    this.deps = deps;
    this.timing = { ...defaultTiming, ...deps.timing };
    this.platform = deps.platform ?? process.platform;
    this.spawnProcess =
      deps.spawn ??
      ((command, args, options) => nodeSpawn(command, args, options));
    this.portOpen = deps.portOpen ?? ((port) => localPortOpen(port));
    this.kill = deps.kill ?? defaultKill(this.platform);
    this.offEvents = deps.onEvent?.((event) => this.observe(event));
    this.sweeper = setInterval(() => this.sweep(), this.timing.sweepMs);
    this.sweeper.unref?.();
    // Servers are process groups of their own: end them with the app.
    process.on("exit", this.onExit);
  }

  onChange(cb: (conversationId: string) => void) {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(conversationId: string) {
    for (const listener of this.listeners) {
      try {
        listener(conversationId);
      } catch {
        // A listener's problem is its own.
      }
    }
  }
  /** Conversations whose servers were listed (so a file change reaches their panel). */
  readonly asked = new Set<string>();

  state(record: ServerRecord): DevServerState {
    const state = this.idleState(record.entry, record.status);
    if (record.port) state.port = record.port;
    if (record.url) state.url = record.url;
    if (record.pid && record.status !== "stopped") state.pid = record.pid;
    if (record.startedAt) state.startedAt = record.startedAt;
    if (record.error) state.error = record.error;
    return state;
  }

  /** The project's Auto-verify choice in launch.json, if it has one. */
  autoVerify(conversationId: string) {
    return launchAutoVerify(this.readConfig(conversationId).result);
  }

  // ---- Approval ----

  /** Whether starting `name` now would ask the person first (Claude's tools). */
  needsApproval(conversationId: string, name: string) {
    const found = this.find(conversationId, name);
    if (!found.entry?.runtimeExecutable) return false;
    return !this.approvals.get(conversationId)?.has(found.key!);
  }

  approve(conversationId: string, key: string) {
    let set = this.approvals.get(conversationId);
    if (!set) this.approvals.set(conversationId, (set = new Set()));
    set.add(key);
  }

  forgetApproval(conversationId: string, key: string) {
    this.approvals.get(conversationId)?.delete(key);
  }

  find(conversationId: string, name: string) {
    const config = this.readConfig(conversationId);
    if (!config.folder) return { error: config.folderError };
    const entry = config.result.configurations.find(
      (item) => lower(item.name) === lower(name),
    );
    if (!entry)
      return {
        folder: config.folder,
        error: `There's no dev server named "${name}" in launch.json.`,
      };
    return {
      folder: config.folder,
      entry,
      key: launchCommandKey(config.folder, entry),
    };
  }

  /** The record now registered under this record's name. */
  current(record: ServerRecord) {
    return this.records.get(record.conversationId)?.get(lower(record.name));
  }

  async logs(conversationId: string, name: string, lines = 200) {
    const record = this.records.get(conversationId)?.get(lower(name));
    return record ? record.logs.tail(lines) : [];
  }

  /** Stops every server (sign-out) and releases watchers and timers. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.offEvents?.();
    clearInterval(this.sweeper);
    if (this.recheck) clearInterval(this.recheck);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    const all = [...this.records.values()].flatMap((records) => [
      ...records.values(),
    ]);
    await Promise.all(all.map((record) => this.stopRecord(record)));
    for (const record of all)
      if (record.status !== "failed" && record.status !== "crashed")
        record.status = "stopped";
    process.off("exit", this.onExit);
    this.listeners.clear();
  }
}

export interface DevServers {
  closeConversation: OmitThisParameter<
    typeof devServersWatch.closeConversation
  >;
  sweep: OmitThisParameter<typeof devServersWatch.sweep>;
  observe: OmitThisParameter<typeof devServersWatch.observe>;
  probeDetected: OmitThisParameter<typeof devServersWatch.probeDetected>;
  scheduleRecheck: OmitThisParameter<typeof devServersWatch.scheduleRecheck>;
  killAllNow: OmitThisParameter<typeof devServersWatch.killAllNow>;
}
installMethods(DevServers.prototype, devServersWatch);

export interface DevServers {
  start: OmitThisParameter<typeof devServersRun.start>;
  run: OmitThisParameter<typeof devServersRun.run>;
  removeRecord: OmitThisParameter<typeof devServersRun.removeRecord>;
  fail: OmitThisParameter<typeof devServersRun.fail>;
  exited: OmitThisParameter<typeof devServersRun.exited>;
  stopRecord: OmitThisParameter<typeof devServersRun.stopRecord>;
  stop: OmitThisParameter<typeof devServersRun.stop>;
}
installMethods(DevServers.prototype, devServersRun);

export interface DevServers {
  folder: OmitThisParameter<typeof devServersConfig.folder>;
  inside: OmitThisParameter<typeof devServersConfig.inside>;
  readConfig: OmitThisParameter<typeof devServersConfig.readConfig>;
  watch: OmitThisParameter<typeof devServersConfig.watch>;
  conversationsIn: OmitThisParameter<typeof devServersConfig.conversationsIn>;
  launchConfig: OmitThisParameter<typeof devServersConfig.launchConfig>;
  configurations: OmitThisParameter<typeof devServersConfig.configurations>;
  list: OmitThisParameter<typeof devServersConfig.list>;
  idleState: OmitThisParameter<typeof devServersConfig.idleState>;
  detect: OmitThisParameter<typeof devServersConfig.detect>;
  save: OmitThisParameter<typeof devServersConfig.save>;
  setAutoVerify: OmitThisParameter<typeof devServersConfig.setAutoVerify>;
  writeConfig: OmitThisParameter<typeof devServersConfig.writeConfig>;
}
installMethods(DevServers.prototype, devServersConfig);
