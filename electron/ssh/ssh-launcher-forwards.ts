import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { SshHost } from "../../shared/ssh-api";
import type { SshServiceApi } from "../ipc/ssh";
import type { EngineLaunch, EngineLaunchInput } from "../engine/engine-types";
import type { AskpassSession } from "./askpass";
import { privateRuntimeDir } from "./connection";
import { collectOutput } from "./connection-support";
import { errorMessage } from "./connection-support";
import { controlPath } from "./connection-support";
import {
  RemoteRuntime,
  RemoteRuntimeError,
  clientIdFor,
  type RemoteRuntimeLayout,
} from "./remote-runtime";
import { remoteCommand } from "./remote-scripts";
import { RUNTIME_CACHE_DIR, RuntimeCache } from "./runtime-cache";
import { deviceId } from "../sub2api/provision";
import {
  LaunchError,
  engineId,
  wrapperScript,
  parseAllocatedPort,
  parseForwardOutput,
  gatewayAddress,
  noAskpass,
} from "./ssh-launcher-support";
import type { SshLauncher } from "./ssh-launcher";

export async function launch(
  this: SshLauncher,
  input: EngineLaunchInput,
): Promise<EngineLaunch> {
  this.closing = false;
  const { service, host, connection, probe } = await this.connected(
    input.interactive,
  );
  const hostId = this.options.hostId;
  this.platform = probe.os === "Darwin" ? "darwin" : "linux";

  // The runtime, installed or checked.
  this.runtime =
    this.options.runtime?.(connection, host) ??
    service.runtime?.(hostId) ??
    new RemoteRuntime({
      shell: connection,
      probe,
      label: host.label,
      clientId: clientIdFor(deviceId(this.options.dataRoot)),
      remoteRoot: host.remoteRoot,
      cache: new RuntimeCache({
        dir: path.join(this.options.dataRoot, RUNTIME_CACHE_DIR),
      }),
      mirror: this.options.mirror?.() ?? null,
      onStatus: (status) => this.report(connection, status),
    });
  let layout: RemoteRuntimeLayout;
  try {
    layout = await this.runtime.ensure();
  } catch (error) {
    const code =
      error instanceof RemoteRuntimeError ? error.code : "install-failed";
    const message =
      error instanceof Error ? error.message : errorMessage(code, host.label);
    this.report(connection, { state: "error", code, message });
    throw new LaunchError(message, false, code);
  }
  connection.setStatus({ state: "starting" });

  const gateway = gatewayAddress(input.gatewayUrl);
  const id = (this.currentEngine = engineId());
  const script = wrapperScript({
    layout,
    engineId: id,
    args: input.args,
    basePath: gateway.path,
  });
  // The wrapper reads the token as one line of stdin.
  if (!/^[\x21-\x7e]{1,1024}$/.test(input.gatewayToken))
    throw new LaunchError("The gateway token is damaged.");
  const config = Buffer.from(input.configToml, "utf8").toString("base64");
  const tail = `${input.gatewayToken}\n${config}\n`;

  if (this.shares) {
    const port = await this.openForward(host, gateway.port);
    const args = connection.commandArgs(remoteCommand(script));
    return {
      spawn: () =>
        connection.spawnSsh(
          args,
          noAskpass,
        ) as unknown as ChildProcessWithoutNullStreams,
      preamble: `${port}\n${tail}`,
    };
  }
  // Windows: the app-server's own ssh carries the forward and signs in.
  const args = connection
    .commandArgs(remoteCommand(script), [
      "-o",
      "ExitOnForwardFailure=yes",
      "-R",
      `127.0.0.1:0:127.0.0.1:${gateway.port}`,
    ])
    .map((arg) => (arg === "LogLevel=ERROR" ? "LogLevel=INFO" : arg));
  const askpass = this.askpass(
    service,
    input.interactive,
    connection.savedPassword?.(),
  );
  return {
    spawn: () =>
      connection.spawnSsh(
        args,
        askpass,
      ) as unknown as ChildProcessWithoutNullStreams,
    preamble: async (child) => {
      const port = await this.allocatedPort(child);
      askpass.close();
      return `${port}\n${tail}`;
    },
  };
}

/** An askpass session for a Windows engine process, when the service has one. */
export function askpass(
  this: SshLauncher,
  service: SshServiceApi,
  interactive: boolean,
  password?: string,
) {
  const broker = (
    service as unknown as {
      broker?: {
        session(options: {
          hostId: string;
          interactive: boolean;
          password?: string;
        }): AskpassSession;
      };
    }
  ).broker;
  this.askpassSession?.close();
  this.askpassSession = broker
    ? broker.session({ hostId: this.options.hostId, interactive, password })
    : noAskpass;
  return this.askpassSession;
}

/** Waits for ssh's "Allocated port" line on the engine's own ssh process. */
export function allocatedPort(
  this: SshLauncher,
  child: ChildProcess,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const done = (error?: Error, port?: number) => {
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      // The rest of ssh's output is read and dropped.
      child.stderr?.on("data", () => {});
      if (error) reject(error);
      else resolve(port!);
    };
    const onData = (chunk: Buffer | string) => {
      if (stderr.length < 16_384) stderr += chunk.toString();
      const port = parseAllocatedPort(stderr);
      if (port) done(undefined, port);
    };
    const onExit = () =>
      done(
        new LaunchError(
          errorMessage("forward-failed", this.label),
          false,
          "forward-failed",
        ),
      );
    const timer = setTimeout(() => {
      child.kill();
      onExit();
    }, this.options.forwardTimeoutMs ?? 60_000);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
}

/** `ssh -O forward` over the master; returns the host's port. */
export async function openForward(
  this: SshLauncher,
  host: SshHost,
  gatewayPort: number,
) {
  await this.closeForward(host);
  const spec = `127.0.0.1:0:127.0.0.1:${gatewayPort}`;
  const result = await this.control(host, "forward", spec);
  const port =
    result.code === 0 ? parseForwardOutput(result.stdout) : undefined;
  if (!port)
    throw new LaunchError(
      errorMessage("forward-failed", host.label),
      false,
      "forward-failed",
    );
  this.forward = { port, gateway: gatewayPort };
  return port;
}

export async function closeForward(this: SshLauncher, host?: SshHost) {
  const forward = this.forward;
  this.forward = undefined;
  const target = host ?? this.options.ssh()?.hosts.get(this.options.hostId);
  if (!forward || !target || !this.shares) return;
  try {
    // OpenSSH's mux finds the forward by the spec it was opened with
    // (listen port 0), not by the port the host allocated; the latter is
    // "port not found" and leaves the forward open (R9-S7 end-to-end test).
    await this.control(
      target,
      "cancel",
      `127.0.0.1:0:127.0.0.1:${forward.gateway}`,
    );
  } catch {
    // The master is gone, and the forward with it.
  }
}

export function control(
  this: SshLauncher,
  host: SshHost,
  command: "forward" | "cancel",
  spec: string,
) {
  const spawn = this.options.spawn ?? spawnProcess;
  const child = spawn(
    this.sshPath(host),
    [
      "-o",
      `ControlPath=${controlPath(privateRuntimeDir(this.options.dataRoot), host.id)}`,
      "-O",
      command,
      "-R",
      spec,
      "--",
      host.destination,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  return collectOutput(child, { timeoutMs: 20_000, maxOutput: 4096 });
}
