import path from "node:path";
import type { SshEvent, SshHost, SshStatus } from "../../shared/ssh-api";
import type { AppContext } from "../app/app-context";
import type { ClientPolicy } from "../../shared/client-policy";
import { AskpassBroker } from "../ssh/askpass";
import { SshConnection, privateRuntimeDir } from "../ssh/connection";
import { errorMessage } from "../ssh/connection-support";
import { SshHostStore } from "../ssh/host-store";
import { SshPasswordStore } from "../ssh/password-store";
import {
  RemoteRuntime,
  RemoteRuntimeError,
  clientIdFor,
} from "../ssh/remote-runtime";
import {
  RUNTIME_CACHE_DIR,
  RuntimeCache,
  runtimeManifest,
} from "../ssh/runtime-cache";
import { deviceId } from "../sub2api/provision";
import {
  checkCustomSsh,
  findSsh,
  readSshVersion,
  supportedSshVersion,
} from "../ssh/ssh-binary";
import { sshPolicyError } from "../ssh/policy";

/**
 * SSH remote environments (R9, shared/ssh-api.ts): the hosts the person
 * added, their connections through the computer's own ssh, askpass
 * questions and remote folders.
 *
 * The service lives while an account is signed in (`ctx.services.ssh`, for
 * R9-S2/S3 to run the remote runtime on a connection) and closes every
 * connection on sign-out and when the app exits. The administrator's
 * policy can turn SSH off (`sshRemote: false`); then no SSH entry shows,
 * connecting is refused and open connections close.
 */

/** What other packages (R9-S2/S3/S4) use from the SSH service. */
export interface SshServiceApi {
  readonly hosts: SshHostStore;
  /** The connection of a saved host (created on first use). */
  connection(hostId: string): SshConnection;
  /** A connection that already exists, without creating one. */
  existing(hostId: string): SshConnection | undefined;
  /** Connects a saved host; `interactive` when the person asked. */
  connect(hostId: string, interactive?: boolean): Promise<SshStatus>;
  /** The administrator allows SSH connections. */
  allowed(): boolean;
  policy?(): ClientPolicy;
  /**
   * The Codex runtime of a connected host: one install shared by the
   * set-up that starts as the connection is ready and the engine.
   */
  runtime?(hostId: string): RemoteRuntime;
}

/**
 * The runtimes fetched ahead of time: the Linux hosts most connections go to. A
 * host of another kind gets its package fetched the moment it is probed.
 */
const PREFETCHED_TRIPLES = [
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
];
/** After launch, so the downloads don't compete with start-up. */
const PREFETCH_DELAY_MS = 20_000;

declare module "../app/app-context" {
  interface SshSlot extends SshServiceApi {}
}

/** Remote folders one host may remember in a session. */
export const MAX_REMOTE_FOLDERS = 200;

/** The administrator's switch (policy field `sshRemote`, default on). */
export function sshAllowed(ctx: Pick<AppContext, "policy">): boolean {
  try {
    return (ctx.policy() as { sshRemote?: unknown }).sshRemote !== false;
  } catch {
    return true;
  }
}

export interface SshServiceOptions {
  /**
   * Fetch runtimes ahead of time and install one as a host connects
   * (default on; tests of other parts turn it off).
   */
  prepareRuntimes?: boolean;
}

export class SshService implements SshServiceApi {
  readonly hosts: SshHostStore;
  readonly passwords: SshPasswordStore;
  private connections = new Map<string, SshConnection>();
  private broker: AskpassBroker | undefined;
  private sshPath: string | null | undefined;
  private version: Promise<string | undefined> | undefined;
  private readonly killAll = () => {
    for (const connection of this.connections.values()) connection.kill();
  };
  private readonly unsubscribe: (() => void)[] = [];
  private readonly cache: RuntimeCache;
  private readonly runtimes = new Map<
    string,
    {
      connection: SshConnection;
      probe: unknown;
      key: string;
      runtime: RemoteRuntime;
    }
  >();
  /** Connections whose runtime set-up already started. */
  private readonly preparing = new WeakSet<SshConnection>();

  constructor(
    private readonly ctx: AppContext,
    private readonly options: SshServiceOptions = {},
  ) {
    this.hosts = new SshHostStore(ctx.dataRoot);
    this.passwords = new SshPasswordStore(ctx.dataRoot, () =>
      ctx.credentials?.canPersist ? ctx.credentials.vaultKey : "",
    );
    this.cache = new RuntimeCache({
      dir: path.join(ctx.dataRoot, RUNTIME_CACHE_DIR),
    });
    process.on("exit", this.killAll);
    if (this.prepares && this.allowed() && this.hosts.list().length) {
      const timer = setTimeout(() => this.prefetch(), PREFETCH_DELAY_MS);
      timer.unref?.();
      this.unsubscribe.push(() => clearTimeout(timer));
    }
    this.unsubscribe.push(
      ctx.onEvent((event) => {
        if (event.type === "policy") void this.closeAll(!this.allowed());
      }),
    );
    void this.watchPower();
  }

  private get prepares() {
    return this.options.prepareRuntimes !== false;
  }

  private mirror(): string | null {
    try {
      return (
        (this.ctx.policy() as { codexRuntimeMirror?: string | null })
          .codexRuntimeMirror ?? null
      );
    } catch {
      return null;
    }
  }

  /** Fetches runtimes into this computer's cache in the background. */
  prefetch(triples: string[] = PREFETCHED_TRIPLES) {
    if (!this.prepares) return;
    const manifest = runtimeManifest();
    for (const triple of triples) {
      const pkg = manifest.platforms[triple];
      if (pkg)
        void this.cache.ensure(pkg, { mirror: this.mirror() }).catch(() => {
          // Tried again at the next set-up, which reports a failure.
        });
    }
  }

  runtime(hostId: string): RemoteRuntime {
    const connection = this.connection(hostId);
    const host = this.hosts.get(hostId);
    const probe = connection.probe;
    if (!host || !probe)
      throw new Error(`Connect to ${host?.label ?? "the host"} first.`);
    const key = `${host.remoteRoot ?? ""}\n${host.label}`;
    const cached = this.runtimes.get(hostId);
    if (
      cached &&
      cached.connection === connection &&
      cached.probe === probe &&
      cached.key === key
    )
      return cached.runtime;
    const runtime = new RemoteRuntime({
      shell: connection,
      probe,
      label: host.label,
      clientId: clientIdFor(deviceId(this.ctx.dataRoot)),
      remoteRoot: host.remoteRoot,
      cache: this.cache,
      mirror: this.mirror(),
      // Only while the connection is up (it may have dropped meanwhile).
      onStatus: (status) => {
        const state = connection.status.state;
        if (state === "installing" || state === "starting" || state === "ready")
          connection.setStatus(status);
      },
    });
    this.runtimes.set(hostId, { connection, probe, key, runtime });
    return runtime;
  }

  /**
   * A host just connected: its runtime is installed (uploaded from this
   * computer's cache) right away, not at the first message. A failure is
   * the connection's error; the next connection or message tries again.
   */
  private prepare(hostId: string, connection: SshConnection) {
    if (!this.prepares) return;
    if (this.preparing.has(connection) || !connection.probe) return;
    this.preparing.add(connection);
    let runtime: RemoteRuntime;
    try {
      runtime = this.runtime(hostId);
      runtime.package();
    } catch {
      // An unsupported host: the engine reports it when it starts.
      return;
    }
    void runtime.ensure().then(
      () => {
        if (connection.status.state === "installing")
          connection.setStatus({ state: "ready" });
      },
      (error: unknown) => {
        this.preparing.delete(connection);
        if (connection.status.state !== "installing") return;
        connection.setStatus({
          state: "error",
          code:
            error instanceof RemoteRuntimeError ? error.code : "install-failed",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  /** Waking up or coming back online retries reconnects at once. */
  private async watchPower() {
    if (!process.versions.electron) return;
    try {
      const electron = (await import("electron")) as any;
      const powerMonitor =
        electron.powerMonitor ?? electron.default?.powerMonitor;
      if (!powerMonitor?.on) return;
      const retry = () => {
        for (const connection of this.connections.values())
          connection.retryNow();
      };
      powerMonitor.on("resume", retry);
      powerMonitor.on("unlock-screen", retry);
      this.unsubscribe.push(() => {
        powerMonitor.off?.("resume", retry);
        powerMonitor.off?.("unlock-screen", retry);
      });
    } catch {
      // Not running in Electron (tests).
    }
  }

  allowed() {
    return sshAllowed(this.ctx);
  }

  policy() {
    return this.ctx.policy();
  }

  /** The default ssh program; null when OpenSSH is not installed. */
  defaultSsh(): string | undefined {
    const configured = this.ctx.policy().sshClientPath;
    if (configured) return configured;
    if (this.sshPath === undefined) this.sshPath = findSsh() ?? null;
    return this.sshPath ?? undefined;
  }

  sshVersion() {
    const ssh = this.defaultSsh();
    if (!ssh) return Promise.resolve(undefined);
    this.version ??= readSshVersion(ssh);
    return this.version;
  }

  sshFor(host: Pick<SshHost, "sshPath">): string | undefined {
    const configured = this.ctx.policy().sshClientPath;
    if (configured) return configured;
    if (host.sshPath) {
      try {
        return checkCustomSsh(host.sshPath);
      } catch {
        return undefined;
      }
    }
    return this.defaultSsh();
  }

  async askpass(): Promise<AskpassBroker> {
    if (!this.broker) {
      this.broker = new AskpassBroker({
        dir: path.join(privateRuntimeDir(this.ctx.dataRoot), "askpass"),
        helperScript: path.join(
          path.dirname(this.ctx.providerServiceScript),
          "ssh-askpass.cjs",
        ),
        execPath: process.execPath,
        emit: (event: SshEvent) => this.ctx.push(event),
      });
    }
    await this.broker.start();
    return this.broker;
  }

  existing(hostId: string) {
    return this.connections.get(hostId);
  }

  connection(hostId: string): SshConnection {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error("That SSH connection no longer exists.");
    let connection = this.connections.get(hostId);
    if (connection) {
      connection.host = host;
      return connection;
    }
    const sshPath = this.sshFor(host);
    if (!sshPath)
      throw new Error(
        host.sshPath
          ? "The SSH program set for this connection doesn't exist."
          : errorMessage("ssh-missing", host.label),
      );
    if (!this.broker) throw new Error("SSH prompts aren't ready yet.");
    connection = new SshConnection({
      host,
      sshPath,
      runtimeDir: privateRuntimeDir(this.ctx.dataRoot),
      askpass: this.broker,
      password: () => this.passwords.get(hostId),
      beforeConnect: async () => {
        const failure = await sshPolicyError(
          this.ctx.policy(),
          connection!.host,
          sshPath,
        );
        return failure ? { state: "error", ...failure } : undefined;
      },
      onStatus: (status) => {
        if (status.state === "ready") this.hosts.touch(hostId);
        this.ctx.push({ type: "ssh-status", hostId, status });
        if (status.state === "ready" && connection)
          queueMicrotask(() => connection && this.prepare(hostId, connection));
      },
    });
    this.connections.set(hostId, connection);
    return connection;
  }

  async connect(hostId: string, interactive = true): Promise<SshStatus> {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error("That SSH connection no longer exists.");
    if (!this.allowed()) {
      const status: SshStatus = {
        state: "error",
        code: "policy-disabled",
        message: errorMessage("policy-disabled", host.label),
      };
      this.ctx.push({ type: "ssh-status", hostId, status });
      return status;
    }
    if (!this.sshFor(host)) {
      const status: SshStatus = {
        state: "error",
        code: "ssh-missing",
        message: host.sshPath
          ? "The SSH program set for this connection doesn't exist."
          : errorMessage("ssh-missing", host.label),
      };
      this.ctx.push({ type: "ssh-status", hostId, status });
      return status;
    }
    const program = this.sshFor(host)!;
    const policyError = await sshPolicyError(this.ctx.policy(), host, program);
    const version = await readSshVersion(program);
    const code =
      policyError?.code ??
      (this.ctx.policy().sshClientPath && !supportedSshVersion(version)
        ? "ssh-managed-unusable"
        : version && !supportedSshVersion(version)
          ? "ssh-too-old"
          : undefined);
    if (code) {
      const status: SshStatus = {
        state: "error",
        code,
        message: policyError?.message ?? errorMessage(code, host.label),
        ...(code === "ssh-managed-unusable" ? { details: program } : {}),
      };
      this.ctx.push({ type: "ssh-status", hostId, status });
      return status;
    }
    await this.askpass();
    return this.connection(hostId).connect({ interactive });
  }

  async disconnect(hostId: string) {
    const connection = this.connections.get(hostId);
    this.connections.delete(hostId);
    await connection?.disconnect();
  }

  async closeAll(policy = false) {
    const ids = [...this.connections.keys()];
    await Promise.allSettled(ids.map((id) => this.disconnect(id)));
    if (policy)
      for (const hostId of ids)
        this.ctx.push({
          type: "ssh-status",
          hostId,
          status: {
            state: "error",
            code: "policy-disabled",
            message: errorMessage("policy-disabled", ""),
          },
        });
  }

  async dispose() {
    for (const stop of this.unsubscribe.splice(0)) stop();
    await this.closeAll();
    this.broker?.close();
    this.broker = undefined;
    process.off("exit", this.killAll);
  }
}
