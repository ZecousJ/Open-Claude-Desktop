/**
 * One SSH host's connection (R9), made with the computer's own ssh.
 *
 * On macOS and Linux Claudex keeps one master connection per host
 * (`ssh -M`, ControlMaster) and every later command (the host check, the
 * runtime install, the remote Codex) rides on it, so the person signs in
 * once. The master's own session runs `cat` on the host and holds the pipe
 * from the app: when the app quits or crashes the pipe closes, the session
 * ends and the master exits, so no ssh process outlives Claudex. Windows'
 * OpenSSH has no connection sharing, so there every command is its own
 * ssh process (an ssh key with ssh-agent avoids repeated prompts).
 *
 * States: idle → connecting → (needs-auth) → probing → ready, then
 * reconnecting after a drop, or error with a code. "ready" means the
 * connection is up and the host was checked (Linux or macOS, x64 or
 * arm64); installing and starting the remote runtime come from R9-S2/S3
 * through `setStatus`.
 *
 * Safety: ssh is always started with an argument list (never a local
 * shell), the destination comes after "--", agent and X11 forwarding are
 * off (agent forwarding only when the person turned it on for the host),
 * host keys are checked against the person's known_hosts with a prompt
 * for new ones, a changed host key is a hard error, and ssh's own error
 * text is mapped to a code and a fixed message (host names, users and
 * prompts stay out of logs).
 */
import {
  spawn as spawnProcess,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SshErrorCode, SshHost, SshStatus } from "../../shared/ssh-api";
import type { AskpassSession, AskpassSessionOptions } from "./askpass";
import {
  INPUT_PROBE_SCRIPT,
  parseProbe,
  platformLabel,
  remoteCommand,
  supportedPlatform,
  type HostProbe,
} from "./remote-scripts";
import { supportsControlMaster } from "./ssh-binary";
import { controlPath } from "./connection-support";
import { baseSshArgs } from "./connection-support";
import { classifyConfiguredSshError } from "./connection-support";
import { errorMessage } from "./connection-support";
import { sshTechnicalDetails } from "./connection-support";
import { collectOutput } from "./connection-support";
import * as connectionSession from "./connection-session";
import { installMethods } from "./install-methods";

/** Longest socket path macOS allows is 104 bytes; ssh adds a 17-byte suffix while binding. */
const MAX_SOCKET_PATH = 100 - 17;

/**
 * A private folder (0700) for the control sockets and the askpass socket. The
 * profile folder when its paths are short enough for a socket and have no white
 * space, else /tmp/claudex-<uid>, which must be a real folder owned by this
 * user and closed to others. ssh cuts `-o ControlPath=…` at a space.
 */
export function privateRuntimeDir(
  dataRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const preferred = path.join(dataRoot, "ssh");
  if (
    platform === "win32" ||
    (path.join(preferred, "cm", "0123456789abcdef").length <= MAX_SOCKET_PATH &&
      !/\s/.test(preferred))
  ) {
    fs.mkdirSync(preferred, { recursive: true, mode: 0o700 });
    return preferred;
  }
  const uid = process.getuid?.() ?? 0;
  const fallback = `/tmp/claudex-${uid}`;
  try {
    fs.mkdirSync(fallback, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(fallback);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Claudex's folder for SSH connections isn't private.");
  return fallback;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Written to the command's stdin, which is then closed. */
  input?: string | Buffer;
  /** Default 30 seconds. */
  timeoutMs?: number;
  /** Default 4 MB of output; more stops the command. */
  maxOutput?: number;
}

/** What the connection needs from the askpass broker. */
export interface AskpassSource {
  session(options: AskpassSessionOptions): AskpassSession;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SshConnectionOptions {
  host: SshHost;
  sshPath: string;
  platform?: NodeJS.Platform;
  /** From privateRuntimeDir. */
  runtimeDir: string;
  askpass: AskpassSource;
  /** The host's saved password, read at each attempt (password-store.ts). */
  password?: () => string | undefined;
  onStatus: (status: SshStatus) => void;
  beforeConnect?: () => Promise<
    Extract<SshStatus, { state: "error" }> | undefined
  >;
  spawn?: SpawnFn;
  /** Delay before reconnect attempt n (1-based), in ms. */
  backoff?: (attempt: number) => number;
  /** Gives up after this many reconnect attempts. */
  maxReconnects?: number;
  /** How long to wait for the connection, not counting time spent on prompts. */
  connectTimeoutMs?: number;
}

const defaultBackoff = (attempt: number) =>
  Math.min(60_000, 2_000 * 2 ** (attempt - 1));

export type Attempt = { interactive: boolean };

export class SshConnection {
  toolBinding: { endpointKey: string; hostKey: string } | undefined;
  current: SshStatus = { state: "idle" };
  private connecting: Promise<SshStatus> | undefined;
  master: ChildProcess | undefined;
  private children = new Set<ChildProcess>();
  reconnectTimer: NodeJS.Timeout | undefined;
  reconnectAttempt = 0;
  closing = false;
  private readonly platform: NodeJS.Platform;
  readonly spawnFn: SpawnFn;
  /** What the host check found (after "probing"). */
  probe: HostProbe | undefined;
  host: SshHost;

  constructor(readonly options: SshConnectionOptions) {
    this.host = options.host;
    this.platform = options.platform ?? process.platform;
    this.spawnFn = options.spawn ?? (spawnProcess as SpawnFn);
  }

  get status(): SshStatus {
    return this.current;
  }

  /** For R9-S2/S3: installing, starting, ready, or an error of theirs. */
  setStatus(status: SshStatus) {
    this.current = status;
    this.options.onStatus(status);
  }

  get shares() {
    return supportsControlMaster(this.platform);
  }

  get controlPath() {
    return controlPath(this.options.runtimeDir, this.host.id);
  }

  /**
   * The ssh arguments for one command on the host, riding on the master
   * connection where there is one: options, "--", destination, command.
   * `extra` options go before "--" (R9-S3 adds its remote forward here).
   */
  commandArgs(command: string, extra: string[] = []): string[] {
    return [
      ...baseSshArgs(this.host),
      ...(this.shares
        ? ["-o", `ControlPath=${this.controlPath}`, "-o", "ControlMaster=no"]
        : ["-o", "ControlPath=none"]),
      ...extra,
      "--",
      this.host.destination,
      command,
    ];
  }

  /** Starts ssh with the askpass variables of an attempt. */
  spawnSsh(args: string[], askpass: AskpassSession): ChildProcess {
    const child = this.spawnFn(this.options.sshPath, args, {
      env: { ...process.env, ...askpass.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    child.once("error", () => this.children.delete(child));
    return child;
  }

  /**
   * Connects (or returns the connection in progress). `interactive` is true
   * when the person asked: ssh's questions then go to the window.
   */
  connect(attempt: Attempt = { interactive: true }): Promise<SshStatus> {
    // Already connected (or R9-S2/S3 setting the host up on the connection):
    // starting again would close the live master.
    if (this.live()) return Promise.resolve(this.current);
    this.connecting ??= this.run(attempt).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  settleIdle(): SshStatus {
    this.stopMaster();
    this.setStatus({ state: "idle" });
    return this.current;
  }

  /** The host's saved password, for ssh processes that sign in again (Windows has no master). */
  savedPassword() {
    return this.options.password?.();
  }

  /** Connected: ready, or R9-S2/S3 setting up the host on the connection. */
  live() {
    const state = this.current.state;
    return state === "ready" || state === "installing" || state === "starting";
  }

  /**
   * The connection dropped (the master exited; on Windows R9-S3 reports its
   * remote Codex channel closing): try again in the background.
   */
  lost() {
    if (this.closing || !this.live()) return;
    this.stopMaster();
    this.reconnectAttempt = 0;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    const attempt = ++this.reconnectAttempt;
    if (attempt > (this.options.maxReconnects ?? 8)) {
      this.fail("host-unreachable");
      return;
    }
    this.setStatus({ state: "reconnecting", attempt });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(
      () => void this.reconnect(),
      (this.options.backoff ?? defaultBackoff)(attempt),
    );
    this.reconnectTimer.unref?.();
  }

  private async reconnect() {
    if (this.closing) return;
    const status = await this.connect({ interactive: false });
    if (this.closing) return;
    // Unreachable or timed out: wait longer and try again. A question
    // (needs-auth) or any other error waits for the person.
    if (
      status.state === "error" &&
      (status.code === "host-unreachable" || status.code === "timeout")
    )
      this.scheduleReconnect();
  }

  /** The network came back or the computer woke: retry a reconnect now. */
  retryNow() {
    if (this.current.state !== "reconnecting" || this.connecting) return;
    clearTimeout(this.reconnectTimer);
    void this.reconnect();
  }

  stopMaster() {
    const master = this.master;
    this.master = undefined;
    if (!master) return;
    master.stdin?.end();
    master.kill();
  }

  /** Closes the connection and every command on it. */
  async disconnect(): Promise<void> {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    const hadMaster = !!this.master;
    this.stopMaster();
    for (const child of this.children) child.kill();
    if (hadMaster && this.shares) {
      await this.control("exit");
      fs.rmSync(this.controlPath, { force: true });
    }
    this.probe = undefined;
    this.toolBinding = undefined;
    this.setStatus({ state: "idle" });
  }

  /** Synchronous last resort when the app exits. */
  kill() {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    this.master?.stdin?.end();
    this.master?.kill();
    for (const child of this.children) child.kill();
  }
}

export interface SshConnection {
  run: OmitThisParameter<typeof connectionSession.run>;
  fail: OmitThisParameter<typeof connectionSession.fail>;
  startMaster: OmitThisParameter<typeof connectionSession.startMaster>;
  control: OmitThisParameter<typeof connectionSession.control>;
  exec: OmitThisParameter<typeof connectionSession.exec>;
  execWith: OmitThisParameter<typeof connectionSession.execWith>;
}
installMethods(SshConnection.prototype, connectionSession);

export interface TestHostOptions {
  host: Pick<
    SshHost,
    "destination" | "port" | "identityFile" | "forwardAgent" | "label"
  >;
  sshPath: string;
  askpass: AskpassSource;
  /** The password typed in the form, or the saved host's. */
  password?: string;
  spawn?: SpawnFn;
}

/**
 * Add connection → Test connection: one ssh process, no master and no
 * saved host (its questions carry hostId ""), running the host check.
 */
export async function testSshHost(options: TestHostOptions): Promise<{
  ok: boolean;
  platform?: string;
  error?: string;
  code?: SshErrorCode;
  details?: string;
}> {
  const spawnFn = options.spawn ?? (spawnProcess as SpawnFn);
  let cancelled = false;
  let child: ChildProcess | undefined;
  const askpass = options.askpass.session({
    hostId: "",
    interactive: true,
    password: options.password,
    onCancel: () => {
      cancelled = true;
      child?.kill();
    },
  });
  try {
    child = spawnFn(
      options.sshPath,
      [
        ...baseSshArgs(options.host),
        "-o",
        "ControlPath=none",
        "-o",
        "ClearAllForwardings=yes",
        "--",
        options.host.destination,
        remoteCommand(INPUT_PROBE_SCRIPT),
      ],
      {
        env: { ...process.env, ...askpass.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const result = await collectOutput(child, {
      timeoutMs: 180_000,
      input: "claudex-stdin\n",
    });
    if (cancelled) return { ok: false, error: "The connection was cancelled." };
    const probe = result.code === 0 ? parseProbe(result.stdout) : undefined;
    if (!probe) {
      const code =
        result.code === null && !result.stderr
          ? "timeout"
          : await classifyConfiguredSshError(
              result.stderr,
              options.sshPath,
              options.host,
            );
      return {
        ok: false,
        code,
        error: errorMessage(code, options.host.label),
        ...(result.stderr && !code.startsWith("local_")
          ? { details: sshTechnicalDetails(result.stderr) }
          : {}),
      };
    }
    const platform = platformLabel(probe);
    if (!supportedPlatform(probe))
      return {
        ok: false,
        platform,
        error: errorMessage(
          "unsupported-platform",
          options.host.label,
          platform,
        ),
      };
    return { ok: true, platform };
  } finally {
    askpass.close();
  }
}
