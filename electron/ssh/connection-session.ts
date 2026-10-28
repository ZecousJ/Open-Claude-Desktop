import { type ChildProcess } from "node:child_process";
import { sshToolBinding } from "./known-hosts";
import fs from "node:fs";
import path from "node:path";
import type { SshErrorCode, SshPrompt, SshStatus } from "../../shared/ssh-api";
import type { AskpassSession } from "./askpass";
import {
  HOLD_SCRIPT,
  INPUT_PROBE_SCRIPT,
  parseProbe,
  platformLabel,
  remoteCommand,
  supportedPlatform,
} from "./remote-scripts";
import { baseSshArgs } from "./connection-support";
import { classifyConfiguredSshError } from "./connection-support";
import { errorMessage } from "./connection-support";
import { sshTechnicalDetails } from "./connection-support";
import { collectOutput } from "./connection-support";
import { delay } from "./connection-support";
import type { SshConnection } from "./connection";
import type { ExecResult, ExecOptions, Attempt } from "./connection";

export async function run(
  this: SshConnection,
  attempt: Attempt,
): Promise<SshStatus> {
  this.toolBinding = undefined;
  this.closing = false;
  const blocked = await this.options.beforeConnect?.();
  if (this.closing) return this.settleIdle();
  if (blocked) {
    this.setStatus(blocked);
    return blocked;
  }
  clearTimeout(this.reconnectTimer);
  if (attempt.interactive) this.reconnectAttempt = 0;
  if (this.current.state !== "reconnecting")
    this.setStatus({ state: "connecting" });
  let needsAuth = false;
  let cancelled = false;
  let openPrompts = 0;
  let abort: (() => void) | undefined;
  const askpass = this.options.askpass.session({
    hostId: this.host.id,
    interactive: attempt.interactive,
    password: this.options.password?.(),
    onPrompt: (_prompt: SshPrompt) => {
      if (!attempt.interactive) {
        needsAuth = true;
        return;
      }
      openPrompts++;
      this.setStatus({ state: "needs-auth" });
    },
    onPromptClosed: () => {
      if (!attempt.interactive) return;
      openPrompts = Math.max(0, openPrompts - 1);
      if (!openPrompts && this.current.state === "needs-auth")
        this.setStatus({ state: "connecting" });
    },
    onCancel: () => {
      cancelled = true;
      abort?.();
    },
  });
  const promptsOpen = () => openPrompts > 0;
  try {
    if (this.shares) {
      const master = await this.startMaster(
        askpass,
        promptsOpen,
        (stop) => {
          abort = stop;
        },
        attempt.interactive,
      );
      if (!master.ok) {
        if (cancelled || this.closing) return this.settleIdle();
        if (needsAuth) return this.fail("needs-auth");
        return this.fail(master.code, undefined, master.details);
      }
    }
    if (cancelled || this.closing) return this.settleIdle();
    this.setStatus({ state: "probing" });
    const result = await this.execWith(INPUT_PROBE_SCRIPT, askpass, {
      input: "claudex-stdin\n",
      timeoutMs: 60_000,
      onStart: (stop) => {
        abort = stop;
      },
    });
    if (cancelled || this.closing) return this.settleIdle();
    const probe = result.code === 0 ? parseProbe(result.stdout) : undefined;
    if (!probe) {
      if (needsAuth) return this.fail("needs-auth");
      return this.fail(
        result.code === 255 ||
          !this.shares ||
          /EXEC_NO_INPUT/.test(result.stderr)
          ? await classifyConfiguredSshError(
              result.stderr,
              this.options.sshPath,
              this.host,
              attempt.interactive,
            )
          : "host-unreachable",
        undefined,
        result.stderr,
      );
    }
    this.probe = probe;
    if (!supportedPlatform(probe))
      return this.fail("unsupported-platform", platformLabel(probe));
    this.toolBinding = await sshToolBinding(this.options.sshPath, this.host);
    if (cancelled || this.closing) return this.settleIdle();
    this.reconnectAttempt = 0;
    this.setStatus({ state: "ready" });
    return this.current;
  } finally {
    askpass.close();
  }
}

export function fail(
  this: SshConnection,
  code: SshErrorCode | "needs-auth",
  detail?: string,
  details?: string,
): SshStatus {
  this.stopMaster();
  if (code === "needs-auth") this.setStatus({ state: "needs-auth" });
  else
    this.setStatus({
      state: "error",
      code,
      message: errorMessage(code, this.host.label, detail),
      ...(details && !code.startsWith("local_")
        ? { details: sshTechnicalDetails(details) }
        : {}),
    });
  return this.current;
}

/** Starts the master and waits until its control socket answers. */
export async function startMaster(
  this: SshConnection,
  askpass: AskpassSession,
  promptsOpen: () => boolean,
  setAbort: (stop: () => void) => void,
  interactive: boolean,
): Promise<{ ok: true } | { ok: false; code: SshErrorCode; details?: string }> {
  const socket = this.controlPath;
  fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
  // A master left from an earlier run (the app crashed while the host
  // was unreachable) would take the socket: close it first.
  if (fs.existsSync(socket)) {
    await this.control("exit");
    fs.rmSync(socket, { force: true });
  }
  const master = this.spawnSsh(
    [
      ...baseSshArgs(this.host),
      "-M",
      "-o",
      `ControlPath=${socket}`,
      "-o",
      "ControlPersist=no",
      "-o",
      "ClearAllForwardings=yes",
      "--",
      this.host.destination,
      remoteCommand(HOLD_SCRIPT),
    ],
    askpass,
  );
  this.master = master;
  let stderr = "";
  master.stderr?.setEncoding("utf8");
  master.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 8192) stderr += chunk;
  });
  master.stdout?.resume();
  master.stdin?.on("error", () => {});
  let exited = false;
  let spawnFailed = false;
  master.once("error", () => {
    spawnFailed = true;
    exited = true;
  });
  master.once("exit", () => {
    exited = true;
    if (this.master === master) this.master = undefined;
    if (this.live() && !this.closing) this.lost();
  });
  setAbort(() => master.kill());
  const limit = this.options.connectTimeoutMs ?? 60_000;
  let waited = 0;
  while (!exited) {
    if (fs.existsSync(socket) && (await this.control("check"))) {
      return { ok: true };
    }
    await delay(100);
    if (!promptsOpen()) waited += 100;
    if (waited > limit) {
      master.kill();
      return { ok: false, code: "timeout" };
    }
  }
  if (spawnFailed) return { ok: false, code: "ssh-missing" };
  // Let the last of the error output arrive.
  await delay(20);
  return {
    ok: false,
    code: await classifyConfiguredSshError(
      stderr,
      this.options.sshPath,
      this.host,
      interactive,
    ),
    details: stderr,
  };
}

/** `ssh -O check|exit` against the host's control socket. */
export function control(
  this: SshConnection,
  command: "check" | "exit",
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = this.spawnFn(
        this.options.sshPath,
        [
          "-o",
          `ControlPath=${this.controlPath}`,
          "-O",
          command,
          "--",
          this.host.destination,
        ],
        { stdio: "ignore", windowsHide: true },
      );
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => child.kill(), 5_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** Runs one of remote-scripts' scripts on the host. */
export async function exec(
  this: SshConnection,
  script: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  if (!this.live() && this.current.state !== "probing")
    throw new Error(
      this.current.state === "reconnecting"
        ? `Reconnecting to ${this.host.label}…`
        : `Connect to ${this.host.label} first.`,
    );
  // Through the master nothing asks; on Windows every command signs in
  // again, and a question is refused rather than popped up unasked.
  const askpass = this.options.askpass.session({
    hostId: this.host.id,
    interactive: false,
    // Without a master each command signs in again with the saved password.
    password: this.savedPassword(),
  });
  try {
    return await this.execWith(script, askpass, options);
  } finally {
    askpass.close();
  }
}

export function execWith(
  this: SshConnection,
  script: string,
  askpass: AskpassSession,
  options: ExecOptions & { onStart?: (stop: () => void) => void },
): Promise<ExecResult> {
  const child = this.spawnSsh(this.commandArgs(remoteCommand(script)), askpass);
  options.onStart?.(() => child.kill());
  return collectOutput(child, options);
}
