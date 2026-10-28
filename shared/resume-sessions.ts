import type { Conversation } from "./types";

export interface ResumableSession {
  handle: string;
  title?: string;
  cwd: string;
  gitBranch?: string;
  lastActivityAt: number;
  folderMissing?: boolean;
  liveness: "closed" | "running" | "unknown";
}

export type ResumeScope = "all" | "folder" | "branch";

/** Folder/branch scope and AND-word search. */
export function filterResumeSessions(
  sessions: readonly ResumableSession[],
  query: string,
  scope: ResumeScope = "all",
  cwd?: string,
  branch?: string,
  caseInsensitive = false,
) {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const normalize = (value: string) =>
    caseInsensitive ? value.toLocaleLowerCase() : value;
  const parent = cwd && normalize(cwd.replace(/[/\\]+$/, ""));
  return sessions.filter((session) => {
    if (session.liveness === "running") return false;
    const folder = normalize(session.cwd);
    const inFolder =
      parent &&
      (folder === parent ||
        folder.startsWith(`${parent}/`) ||
        folder.startsWith(`${parent}\\`));
    if (scope === "folder" && !inFolder) return false;
    if (
      scope === "branch" &&
      (!branch || session.gitBranch !== branch || (cwd && !inFolder))
    )
      return false;
    const text =
      `${session.title ?? ""}\n${resumeFolder(session.cwd)}\n${session.gitBranch ?? ""}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function resumeFolder(cwd: string) {
  const worktree = /^(.*)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)$/.exec(cwd);
  const basename = (value: string) =>
    value
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .at(-1) || value;
  return worktree ? `${basename(worktree[1])} › ${worktree[2]}` : basename(cwd);
}

export interface ResumeSessionsAPI {
  listResumableSessions(): Promise<ResumableSession[]>;
  previewResumeSession(handle: string): Promise<Conversation["turns"]>;
  resumeSession(handle: string): Promise<Conversation>;
}
