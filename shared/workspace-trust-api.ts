/**
 * Workspace trust for Code on this computer.
 *
 * Claudex's agent is Codex, and Codex has its own trust: a project is trusted
 * when `projects."<root>".trust_level = "trusted"` is in its user config.toml,
 * where `<root>` is the folder's Git repository root (the main checkout for a
 * worktree) or the folder itself outside Git. Only a trusted project loads its
 * own `.codex/` config (model, sandbox, MCP servers), hooks and exec policy
 * rules; skills and AGENTS.md load either way. The main process records the
 * choice there (electron/workspace-trust.ts), so Codex honours it, and refuses
 * a Code send in a folder that isn't trusted with `workspaceTrustMessage`; the
 * window then asks and sends again.
 *
 * Desktop only: the web app's sessions run in the runner's sandboxes, which
 * trust their workspaces themselves (as the official web app, which has no
 * trust check, `?? { trusted: true }`).
 */
import { bridgeMethods } from "./bridge-methods";
import type { EnvironmentRef } from "./types";

export interface WorkspaceTrust {
  /** The folder as asked. */
  folder: string;
  /** Where Codex records the trust: the repository root or the folder. */
  root: string;
  trusted: boolean;
  /**
   * The folder's own Codex files that run or change things only once it is
   * trusted ("Execution allowed by:"): `.codex/config.toml`, hooks, rules.
   */
  sources: string[];
  /** The SSH host the folder is on ("on {host}" in the dialog). */
  host?: string;
}

/**
 * Where the folder is: this computer (omitted), or an SSH host, whose
 * trust this computer keeps and writes into the host's Codex config at
 * every start (the official remote trust store). On an SSH host an empty
 * folder means the host's default folder.
 */
export type WorkspaceTrustPlace = Extract<EnvironmentRef, { kind: "ssh" }>;

export interface WorkspaceTrustAPI {
  checkWorkspaceTrust(
    folder: string,
    place?: WorkspaceTrustPlace,
  ): Promise<WorkspaceTrust>;
  /** Records the person's "Trust workspace" in Codex's config. */
  saveWorkspaceTrust(
    folder: string,
    place?: WorkspaceTrustPlace,
  ): Promise<WorkspaceTrust>;
  /** Settings → Claude Code → Trusted folders. */
  trustedWorkspaces(): Promise<string[]>;
  /** Opens a folder picker in the main process; the chosen folder becomes trusted. */
  addTrustedWorkspace(): Promise<string[]>;
  removeTrustedWorkspace(folder: string): Promise<string[]>;
}

export const workspaceTrustMethods = bridgeMethods<WorkspaceTrustAPI>({
  checkWorkspaceTrust: true,
  saveWorkspaceTrust: true,
  trustedWorkspaces: true,
  addTrustedWorkspace: true,
  removeTrustedWorkspace: true,
});

/** The trusted folders changed (another window, or the trust dialog). */
export interface WorkspaceTrustEvent {
  type: "workspace-trust";
}

/**
 * The error a Code send (or edit, retry) fails with in a folder that was never
 * trusted.
 */
export const workspaceTrustMessage = "Codex runs only in workspaces you trust.";

export function isWorkspaceTrustError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(workspaceTrustMessage);
}
