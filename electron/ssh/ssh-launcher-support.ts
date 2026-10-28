import { spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { SshErrorCode, SshHost } from "../../shared/ssh-api";
import type { SshServiceApi } from "../ipc/ssh";
import type { AskpassSession } from "./askpass";
import { type SshConnection } from "./connection";
import { type RemoteRuntimeLayout } from "./remote-runtime";
import { checkRemotePath, shQuote } from "./remote-scripts";

/** An engine could not start; `transient` when it will once the host is back. */
export class LaunchError extends Error {
  constructor(
    message: string,
    readonly transient = false,
    readonly code?: SshErrorCode,
  ) {
    super(message);
  }
}

/** What the launcher needs from the runtime (RemoteRuntime; replaced in tests). */
export interface LauncherRuntime {
  ensure(): Promise<RemoteRuntimeLayout>;
  cleanup(activeEngines: string[]): Promise<void>;
}

export interface SshLauncherOptions {
  hostId: string;
  /** The signed-in account's SSH service (ctx.services.ssh). */
  ssh: () => SshServiceApi | undefined;
  /** userData: the device id, the runtime cache, the control sockets. */
  dataRoot: string;
  /** The administrator's runtime mirror (policy codexRuntimeMirror). */
  mirror?: () => string | null | undefined;
  /** This computer's platform (connection sharing where it isn't Windows). */
  platform?: NodeJS.Platform;
  /** Replaces RemoteRuntime (tests). */
  runtime?: (connection: SshConnection, host: SshHost) => LauncherRuntime;
  /** How long to wait for the forwarded port (default 60 s). */
  forwardTimeoutMs?: number;
  /** How long an unexpected exit waits to tell a dropped connection from a crash (default 500 ms). */
  exitGraceMs?: number;
  spawn?: typeof spawnProcess;
}

/** Engine ids name run/<id>.pid on the host. */
export const engineId = () => "e" + randomBytes(8).toString("hex");

/** Exit codes of the wrapper, before Codex runs. */
export const WRAPPER_EXIT = { preamble: 70, port: 71, config: 72 } as const;

/**
 * The script that starts Codex on the host (see the file comment): reads
 * the port, token and config from stdin, records its pid and replaces
 * itself with the app-server. `args` follow `app-server --listen stdio://`;
 * the gateway's address is added last from the forwarded port.
 */
export function wrapperScript(options: {
  layout: Pick<RemoteRuntimeLayout, "codex" | "home" | "run">;
  engineId: string;
  args: string[];
  /** The gateway's path ("/v1"). */
  basePath: string;
}): string {
  const { layout } = options;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.engineId))
    throw new Error("The engine id is damaged.");
  if (!/^(\/[A-Za-z0-9._~-]+)*$/.test(options.basePath))
    throw new Error("The gateway address is damaged.");
  for (const value of [layout.codex, layout.home, layout.run])
    if (!checkRemotePath(value).startsWith("/"))
      throw new Error("The runtime folder is damaged.");
  for (const arg of options.args)
    if (/[\u0000\r\n]/.test(arg))
      throw new Error("An engine setting contains a line break.");
  const baseUrl = `model_providers.claudex.base_url="http://127.0.0.1:$PORT${options.basePath}"`;
  return [
    `umask 077`,
    `unset OPENAI_API_KEY`,
    `IFS= read -r PORT || exit ${WRAPPER_EXIT.preamble}`,
    `IFS= read -r CLAUDEX_GATEWAY_TOKEN || exit ${WRAPPER_EXIT.preamble}`,
    `IFS= read -r CFG || exit ${WRAPPER_EXIT.preamble}`,
    `case $PORT in ''|*[!0-9]*) exit ${WRAPPER_EXIT.port} ;; esac`,
    `export CLAUDEX_GATEWAY_TOKEN`,
    `CODEX_HOME=${shQuote(layout.home)}`,
    `export CODEX_HOME`,
    `mkdir -p "$CODEX_HOME" 2>/dev/null`,
    // Older macOS base64 only knows -D.
    `{ printf '%s' "$CFG" | base64 -d > "$CODEX_HOME/config.toml" 2>/dev/null || printf '%s' "$CFG" | base64 -D > "$CODEX_HOME/config.toml"; } || exit ${WRAPPER_EXIT.config}`,
    `unset CFG`,
    `printf '%s\\n' "$$" > ${shQuote(`${layout.run}/${options.engineId}.pid`)} 2>/dev/null`,
    `cd "$HOME" 2>/dev/null`,
    `exec ${shQuote(layout.codex)} app-server --listen stdio:// ${options.args
      .map(shQuote)
      .join(" ")} -c "${baseUrl.replaceAll('"', '\\"')}"`,
  ].join("\n");
}

/** ssh's "Allocated port N for remote forward to …" (INFO); undefined until it appears. */
export function parseAllocatedPort(stderr: string): number | undefined {
  const match = /Allocated port (\d{1,5}) for remote forward/.exec(stderr);
  const port = match ? Number(match[1]) : NaN;
  return port > 0 && port < 65536 ? port : undefined;
}

/** `ssh -O forward` prints the port it allocated on a line of its own. */
export function parseForwardOutput(stdout: string): number | undefined {
  const match = /^\s*(\d{1,5})\s*$/m.exec(stdout);
  const port = match ? Number(match[1]) : NaN;
  return port > 0 && port < 65536 ? port : undefined;
}

/** The gateway's port and path from its loopback address. */
export function gatewayAddress(url: string): { port: number; path: string } {
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1" || parsed.protocol !== "http:")
    throw new Error("The gateway isn't on this computer's loopback address.");
  const port = Number(parsed.port);
  if (!(port > 0 && port < 65536))
    throw new Error("The gateway address is damaged.");
  return { port, path: parsed.pathname.replace(/\/+$/, "") };
}

export const noAskpass: AskpassSession = { env: {}, close() {} };
