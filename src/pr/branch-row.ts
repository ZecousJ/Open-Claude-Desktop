import type { CodeGitStatus } from "../../shared/panels-api";
import type { GitHubPullRequest } from "../../shared/github-api";
export { pullRequestIsLive } from "../../shared/pull-request-status";

/**
 * What the Code session's branch row offers: the PR button is Create PR, or
 * Commit changes when the folder has no GitHub remote, or nothing once the
 * branch has a pull request. Why it is greyed out is the tooltip on the button.
 */

/** Which of the split button's choices the person last made. */
export type CreateMode = "create" | "draft" | "compose";

export const createLabels: Record<CreateMode, string> = {
  create: "Create PR",
  draft: "Create draft PR",
  compose: "Manually create PR",
};

export interface PrAction {
  kind: "create" | "commit";
  label: string;
  /** Why the button is off; absent when it works. */
  disabled?: string;
}

export function prAction(input: {
  status: CodeGitStatus;
  /** The session runs in a cloud sandbox (it has no folder of the person's). */
  cloud: boolean;
  /** Claude is working in the session. */
  running: boolean;
  mode: CreateMode;
  /** The branch's existing pull request is still being looked up. */
  lookingUp: boolean;
}): PrAction {
  const { status, cloud, running, lookingUp } = input;
  const changes = status.dirty || status.ahead > 0;
  // A folder without a GitHub remote can only commit (the original's
  // "commit" mode); a cloud session without one can't do either.
  if (!status.repository && !cloud)
    return {
      kind: "commit",
      label: "Commit changes",
      disabled: !status.dirty
        ? "No changes to commit"
        : running
          ? "Claudex is working — wait for the turn to finish"
          : undefined,
    };
  const label = createLabels[input.mode];
  if (!status.repository)
    return {
      kind: "create",
      label,
      disabled: "Add a GitHub remote to create a pull request",
    };
  if (status.baseBranch && status.branch === status.baseBranch)
    return {
      kind: "create",
      label,
      disabled: "Already on the base branch — check out a feature branch first",
    };
  // A cloud session's branch must be on GitHub first; a local one is pushed
  // when the PR is made.
  if (cloud && status.pushed === false)
    return {
      kind: "create",
      label,
      disabled: "Branch hasn’t been pushed to GitHub",
    };
  return {
    kind: "create",
    label,
    disabled: !changes
      ? "No changes to create a PR from"
      : lookingUp
        ? "Checking for an existing pull request"
        : running
          ? "Claudex is working — wait for the turn to finish"
          : undefined,
  };
}

/**
 * The row's tint: a merged request tints the whole row purple, one in the merge
 * queue yellow; either hides the row's diff, CI and buttons.
 */
export function rowAccent(
  pr: GitHubPullRequest | undefined,
): "merged" | "queued" | undefined {
  return pr?.state === "merged" || pr?.state === "queued"
    ? pr.state
    : undefined;
}
