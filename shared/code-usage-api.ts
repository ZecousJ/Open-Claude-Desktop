/**
 * The Code home: the usage card (the local usage log, and for a Sub2API account
 * the service's usage dashboard) and the working folder's Git branch and
 * remotes.
 */
import type { EnvironmentRef, UsageRange, UsageSummary } from "./types";
import { bridgeMethods } from "./bridge-methods";
import type { GitHubPullRequest } from "./github-api";

/** A working folder's Git state, read from files only (no git process). */
export interface WorkspaceGit {
  /** The checked-out branch, or the abbreviated commit when detached; null outside a repository. */
  branch: string | null;
  /** Some remote points at github.com. */
  githubRemote: boolean;
}

/** Token usage the Sub2API service recorded for this account. */
export interface CodeUsageDashboard {
  /** Input + output (+ cache) tokens in the range. */
  tokens: number;
  /** Per requested model, largest first. */
  models: { model: string; input: number; output: number; total: number }[];
  /** Tokens per day (`YYYY-MM-DD`, the computer's time zone), oldest first. */
  daily: { date: string; tokens: number }[];
}

/** A folder's local branches (the folder menu's Branch submenu). */
export interface FolderBranches {
  /** The checked-out branch; null when detached. */
  current: string | null;
  /** Most recently committed first. */
  branches: string[];
  /** origin's default branch, else main or master; null when unknown. */
  defaultBranch?: string | null;
}
/** A folder's uncommitted changes. */
export interface FolderChanges {
  files: number;
  additions: number;
  deletions: number;
}
export type FolderSwitchResult =
  { ok: true } | { ok: false; reason: "dirty" | "elsewhere" | "failed" };
export type FolderChangesAction = "stash" | "commit" | "discard";

export interface CodeUsageAPI {
  usageSummary(range?: UsageRange): Promise<UsageSummary>;
  /** null for a local account or when the service cannot be reached. */
  codeUsageDashboard(range: UsageRange): Promise<CodeUsageDashboard | null>;
  /**
   * null when the folder is not one the user chose (in `environment`: a
   * folder on an SSH host is read on the host, R9), or the host can't be
   * reached.
   */
  workspaceGit(
    folder: string,
    environment?: EnvironmentRef,
  ): Promise<WorkspaceGit | null>;
  /** Desktop: a chosen folder's branches; null outside a repository. */
  folderBranches(folder: string): Promise<FolderBranches | null>;
  /** Desktop: the folder's uncommitted changes; null when git can't tell. */
  folderChanges(folder: string): Promise<FolderChanges | null>;
  /** Desktop: checks out a branch in the folder ("dirty" with uncommitted changes). */
  switchFolderBranch(
    folder: string,
    branch: string,
  ): Promise<FolderSwitchResult>;
  /** Desktop: the open pull request of the folder's branch (through `gh`); null when none. */
  folderPullRequest(folder: string): Promise<GitHubPullRequest | null>;
  /** Desktop: stashes, commits as WIP or discards the folder's changes. */
  resolveFolderChanges(
    folder: string,
    action: FolderChangesAction,
  ): Promise<boolean>;
}

export const codeUsageMethods = bridgeMethods<CodeUsageAPI>({
  usageSummary: true,
  codeUsageDashboard: true,
  workspaceGit: true,
  folderBranches: true,
  folderChanges: true,
  switchFolderBranch: true,
  resolveFolderChanges: true,
  folderPullRequest: true,
});
