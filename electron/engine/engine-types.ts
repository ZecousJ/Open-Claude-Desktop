import type { EnvironmentRef } from "../../shared/types";
import type { SshHost } from "../../shared/ssh-api";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RpcPreamble } from "./rpc";
import type { Outbox } from "../ssh/outbox";
import type { Engine } from "./engine";

/** Whether two environments are the same place (missing means local). */
export function sameEnvironment(a?: EnvironmentRef, b?: EnvironmentRef) {
  const x: EnvironmentRef = a ?? { kind: "local" };
  const y: EnvironmentRef = b ?? { kind: "local" };
  if (x.kind === "local") return y.kind === "local";
  if (x.kind === "space") return y.kind === "space" && x.spaceId === y.spaceId;
  return y.kind === "ssh" && x.hostId === y.hostId;
}

/** What an SSH engine's launcher gets to start Codex on the host (R9). */
export interface EngineLaunchInput {
  /** The app-server arguments after `app-server --listen stdio://` (the gateway address is added by the launcher). */
  args: string[];
  /** CODEX_HOME/config.toml on the host. */
  configToml: string;
  /** This computer's gateway (loopback) and its token for this engine. */
  gatewayUrl: string;
  gatewayToken: string;
  /** The person started this (questions may go to the window). */
  interactive: boolean;
}

export interface EngineLaunch {
  /** Starts the process whose stdio carries JSON-RPC. */
  spawn: () => ChildProcessWithoutNullStreams;
  /** Written to its stdin first (see CodexRPC.startWith). */
  preamble?: RpcPreamble;
}

/**
 * Starts an engine's Codex somewhere other than this computer (R9 SSH:
 * electron/ssh/ssh-launcher.ts). Errors may carry `transient: true` when
 * the host is expected back by itself.
 */
export interface EngineLauncher {
  readonly sshHost?: SshHost;
  readonly sshToolBinding?: { endpointKey: string; hostKey: string };
  readonly environment: EnvironmentRef;
  /** The place's name in messages. */
  readonly label: string;
  /** The host's platform (sandbox choices). */
  readonly platform: NodeJS.Platform;
  /** The host is reconnecting by itself: a message can wait for it. */
  waiting(): boolean;
  /** Where a conversation sent without a folder runs on the host (its home). */
  defaultCwd?(): Promise<string | undefined>;
  /**
   * Codex's workspace trust of a folder there: its real path, its Codex
   * project root and the `.codex` files that load once that is trusted.
   */
  workspaceTrust?(
    folder: string,
    interactive: boolean,
  ): Promise<{ folder: string; root: string; sources: string[] }>;
  launch(input: EngineLaunchInput): Promise<EngineLaunch>;
  /** Codex answered initialize. */
  started(): void;
  /** Codex's process ended without being stopped. */
  exited(): void;
  /** Starting failed (the launch's own error, or Codex not answering). */
  failed(error: Error): void;
  /** The engine stopped; release what the launch opened. */
  dispose(): Promise<void>;
}

export interface EngineOptions {
  environmentVariables?: Record<string, string>;
  /** Where this engine runs its conversations (default: this computer). */
  environment?: EnvironmentRef;
  launcher?: EngineLauncher;
  /** Messages waiting for an SSH host (R9). */
  outbox?: Outbox;
  /**
   * An isolated space (docs/cloud-sync.md): the command that starts Codex in
   * the space's own sandbox, and the folder holding its `codex-home` and
   * `workspace` (default: the store's).
   */
  binary?: string;
  root?: string;
  /** Stops the isolated environment after a runner-release request. */
  releaseEnvironment?: () => Promise<void> | void;
}

/** The other engines of the account, for the local engine to hand work to (R9). */
export interface EnginePeers {
  /** The engine of an environment (created when needed). */
  forEnvironment(environment: EnvironmentRef): Engine;
  /** The other engines running now. */
  all(): Engine[];
}

/** thread/start, thread/resume and thread/fork options; `config` holds Codex config overrides. */
/** One workflow agent's task (electron/workflows). */
export interface WorkflowAgentRequest {
  prompt: string;
  /** A model of the session's provider; otherwise the session's model. */
  model?: string;
  effort?: string;
  /** JSON Schema the agent's final message must follow. */
  outputSchema?: unknown;
  /** Its working folder (a worktree); otherwise the session's. */
  cwd?: string;
  /** Added after the session's own developer instructions. */
  instructions?: string;
}

/** Receives every notification of a workflow agent's thread. */
export type WorkflowThreadListener = (method: string, params: any) => void;
