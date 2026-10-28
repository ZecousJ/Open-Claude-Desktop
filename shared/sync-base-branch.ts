/**
 * Sync with base branch (electron/sync-base-branch.ts): the tool's names, its
 * answer, and the transcript row's words.
 */
export const syncBaseNamespace = "claudex_host";
export const syncBaseTool = "sync_with_base_branch";
/** The host's worktree housekeeping (they ask the person first). */
export const discardKeptWorktreeTool = "discard_kept_worktree";
export const cleanUpWorktreesTool = "clean_up_worktrees";
/** Auto-fix and auto-archive for the session's pull request. */
export const setPrMonitorTool = "set_pr_monitor";
/** The first-turn Code setup question for choosing the working branch. */
export const setupQuestionTool = "setup_question";
export const setupQuestionServer = "claudex_setup_question";

/**
 * What Claude asks to change, as the original phrases it: "turn on auto-fix and
 * turn off auto-archive for pull request #12", and the line on what
 * auto-archive does.
 */
export function prMonitorQuestion(
  number: number,
  change: { autoFix?: boolean; autoArchive?: boolean },
) {
  const on = (value: boolean) => (value ? "turn on" : "turn off");
  const pr = `pull request #${number}`;
  const { autoFix, autoArchive } = change;
  let phrase: string;
  if (autoFix !== undefined && autoArchive !== undefined)
    phrase =
      autoFix === autoArchive
        ? `${on(autoFix)} auto-fix and auto-archive for ${pr}`
        : `${on(autoFix)} auto-fix and ${on(autoArchive)} auto-archive for ${pr}`;
  else if (autoFix !== undefined) phrase = `${on(autoFix)} auto-fix for ${pr}`;
  else phrase = `${on(autoArchive!)} auto-archive for ${pr}`;
  const detail =
    autoArchive === undefined
      ? undefined
      : autoArchive
        ? "Auto-archive archives this session once the pull request merges or closes."
        : "This session stays in your list after the pull request merges or closes.";
  return `Allow Claudex to ${phrase}?${detail ? `\n${detail}` : ""}`;
}

export type SyncBaseOutcome =
  | { outcome: "merged" | "up_to_date"; base: string }
  | { outcome: "conflicts"; base: string; conflicts: string[] }
  | { outcome: "aborted" | "nothing_in_progress" };

const verbs: Record<SyncBaseOutcome["outcome"], string> = {
  merged: "Merged base branch",
  conflicts: "Merge left conflicts to resolve",
  up_to_date: "Branch already up to date",
  aborted: "Abandoned merge",
  nothing_in_progress: "No merge to abandon",
};

/** The row's verb and the base it names, from the tool's answer; undefined while it runs or when unreadable. */
export function syncBaseRow(
  text: string | undefined,
): { verb: string; base?: string } | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<SyncBaseOutcome> & {
      base?: unknown;
    };
    const verb = value && verbs[value.outcome as SyncBaseOutcome["outcome"]];
    if (!verb) return undefined;
    const settled =
      value.outcome === "aborted" || value.outcome === "nothing_in_progress";
    return {
      verb,
      ...(!settled && typeof value.base === "string"
        ? { base: value.base }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** The running row: abandoning when asked to abort, else merging. */
export const syncBaseRunningVerb = (args: unknown) =>
  (args as { abort?: unknown })?.abort === true
    ? "Abandoning merge"
    : "Merging base branch";
