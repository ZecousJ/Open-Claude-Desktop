import type { EnvironmentRef } from "../../shared/types";
import type { SshHost, SshStatus } from "../../shared/ssh-api";
import type { SshServiceApi } from "../ipc/ssh";
import type { EngineLauncher } from "../engine/engine-types";
import type { AskpassSession } from "./askpass";
import { type SshConnection } from "./connection";
import { errorMessage } from "./connection-support";
import { workspaceTrustScript } from "./remote-scripts";
import { parseRemoteTrust } from "../workspace/workspace-trust";
import { checkCustomSsh, findSsh, supportsControlMaster } from "./ssh-binary";
import {
  LaunchError,
  type LauncherRuntime,
  type SshLauncherOptions,
} from "./ssh-launcher-support";
import * as sshLauncherForwards from "./ssh-launcher-forwards";
import { installMethods } from "./install-methods";

export class SshLauncher implements EngineLauncher {
  get sshHost() {
    return this.options.ssh()?.hosts.get(this.options.hostId);
  }
  get sshToolBinding() {
    const connection = this.options.ssh()?.existing(this.options.hostId);
    return connection?.status.state === "ready"
      ? connection.toolBinding
      : undefined;
  }
  readonly environment: EnvironmentRef;
  /** The host's platform once connected (Linux or macOS). */
  platform: NodeJS.Platform = "linux";
  private readonly localPlatform: NodeJS.Platform;
  forward: { port: number; gateway: number } | undefined;
  runtime: LauncherRuntime | undefined;
  currentEngine: string | undefined;
  closing = false;
  askpassSession: AskpassSession | undefined;

  constructor(readonly options: SshLauncherOptions) {
    this.environment = { kind: "ssh", hostId: options.hostId };
    this.localPlatform = options.platform ?? process.platform;
  }

  private service(): SshServiceApi {
    const service = this.options.ssh();
    if (!service) throw new LaunchError("Sign in to continue.");
    return service;
  }

  /** The host's name for messages ("the SSH host" once it was removed). */
  get label(): string {
    try {
      return this.options.ssh()?.hosts.get(this.options.hostId)?.label ?? "";
    } catch {
      return "";
    }
  }

  /**
   * Where a conversation started without a folder runs: the host's Default
   * folder, else the signed-in user's home, read when the connection probed the
   * host. A host not connected yet is connected first (without prompts);
   * undefined when that is not possible.
   */
  async defaultCwd(): Promise<string | undefined> {
    const service = this.service();
    const hostId = this.options.hostId;
    const host = service.hosts.get(hostId);
    if (!host || !service.allowed()) return undefined;
    let connection = service.existing(hostId);
    if (!connection?.probe && !this.waiting()) {
      const status = await service
        .connect(hostId, false)
        .catch(() => undefined);
      if (status?.state !== "ready") return undefined;
      connection = service.existing(hostId);
    }
    const home = connection?.probe?.home;
    const folder = host.defaultFolder;
    if (folder?.startsWith("/")) return folder;
    if (folder && home)
      return folder === "~"
        ? home
        : folder.startsWith("~/")
          ? `${home.replace(/\/$/, "")}/${folder.slice(2)}`
          : `${home.replace(/\/$/, "")}/${folder}`;
    return home || undefined;
  }

  /** The connection exists and is trying to come back by itself. */
  waiting(): boolean {
    const connection = this.options.ssh()?.existing(this.options.hostId);
    return connection?.status.state === "reconnecting";
  }

  get shares() {
    return supportsControlMaster(this.localPlatform);
  }

  sshPath(host: SshHost): string {
    const policy = this.service().policy?.();
    const found =
      policy?.sshClientPath ??
      (host.sshPath ? checkCustomSsh(host.sshPath) : findSsh());
    if (!found) throw new LaunchError(errorMessage("ssh-missing", host.label));
    return found;
  }

  /** Sets the connection's status unless it already moved on (dropped, closed). */
  report(connection: SshConnection, status: SshStatus) {
    const state = connection.status.state;
    if (state === "installing" || state === "starting" || state === "ready")
      connection.setStatus(status);
  }

  /** The host's connection, connected first when it isn't (questions only when `interactive`). */
  async connected(interactive: boolean) {
    const service = this.service();
    const hostId = this.options.hostId;
    const host = service.hosts.get(hostId);
    if (!host) throw new LaunchError("That SSH connection no longer exists.");
    if (!service.allowed())
      throw new LaunchError(
        errorMessage("policy-disabled", host.label),
        false,
        "policy-disabled",
      );
    const existing = service.existing(hostId);
    if (existing?.status.state === "reconnecting")
      throw new LaunchError(`Reconnecting to ${host.label}…`, true);
    const state = existing?.status.state;
    if (state !== "ready" && state !== "installing" && state !== "starting") {
      const status = await service.connect(hostId, interactive);
      if (status.state !== "ready")
        throw new LaunchError(
          status.state === "error"
            ? status.message
            : status.state === "needs-auth"
              ? `Sign in to ${host.label} to continue.`
              : `Reconnecting to ${host.label}…`,
          status.state === "reconnecting",
          status.state === "error" ? status.code : undefined,
        );
    }
    const connection = service.connection(hostId);
    const probe = connection.probe;
    if (!probe) throw new LaunchError(`Reconnecting to ${host.label}…`, true);
    return { service, host, connection, probe };
  }

  /**
   * Codex's trust of a folder on the host: the folder's real path, its Codex
   * project root and the `.codex` files that load once the root is trusted.
   */
  async workspaceTrust(
    folder: string,
    interactive: boolean,
  ): Promise<{ folder: string; root: string; sources: string[] }> {
    const { connection } = await this.connected(interactive);
    const result = await connection.exec(workspaceTrustScript(folder), {
      timeoutMs: 20_000,
      maxOutput: 65_536,
    });
    const found =
      result.code === 0 ? parseRemoteTrust(result.stdout) : undefined;
    if (!found)
      throw new LaunchError(
        "Couldn’t check whether this workspace is trusted. Try again.",
      );
    return found;
  }

  /**
   * Starting failed after the host was reached: the connection shows why
   * (a host that dropped meanwhile keeps reconnecting instead).
   */
  failed(error: Error): void {
    if (error instanceof LaunchError && error.transient) return;
    const connection = this.options.ssh()?.existing(this.options.hostId);
    if (!connection) return;
    const own = error instanceof LaunchError && error.code;
    this.report(connection, {
      state: "error",
      code: own ? error.code! : "engine-exited",
      message: own
        ? error.message
        : errorMessage("engine-exited", connection.host.label),
    });
  }

  /** Codex answered: the host is ready, and engines left from earlier runs end. */
  started(): void {
    const connection = this.options.ssh()?.existing(this.options.hostId);
    if (connection) this.report(connection, { state: "ready" });
    const runtime = this.runtime;
    const id = this.currentEngine;
    if (runtime && id)
      void runtime.cleanup([id]).catch(() => {
        // Cleaning up is best effort; the next start tries again.
      });
  }

  /**
   * The engine's ssh process ended without being asked. A dropped
   * connection reconnects by itself (the master's exit, or on Windows this
   * channel, which is the connection); otherwise Codex itself stopped.
   */
  exited(): void {
    if (this.closing) return;
    this.askpassSession?.close();
    this.askpassSession = undefined;
    const connection = this.options.ssh()?.existing(this.options.hostId);
    if (!connection) return;
    if (!this.shares) {
      connection.lost();
      return;
    }
    const timer = setTimeout(() => {
      if (this.closing) return;
      const state = connection.status.state;
      if (state === "ready" || state === "starting")
        connection.setStatus({
          state: "error",
          code: "engine-exited",
          message: errorMessage("engine-exited", connection.host.label),
        });
    }, this.options.exitGraceMs ?? 500);
    timer.unref?.();
  }

  /** The engine stopped on purpose: the forward goes too. */
  async dispose(): Promise<void> {
    this.closing = true;
    this.askpassSession?.close();
    this.askpassSession = undefined;
    this.currentEngine = undefined;
    await this.closeForward();
  }
}

export interface SshLauncher {
  launch: OmitThisParameter<typeof sshLauncherForwards.launch>;
  askpass: OmitThisParameter<typeof sshLauncherForwards.askpass>;
  allocatedPort: OmitThisParameter<typeof sshLauncherForwards.allocatedPort>;
  openForward: OmitThisParameter<typeof sshLauncherForwards.openForward>;
  closeForward: OmitThisParameter<typeof sshLauncherForwards.closeForward>;
  control: OmitThisParameter<typeof sshLauncherForwards.control>;
}
installMethods(SshLauncher.prototype, sshLauncherForwards);
