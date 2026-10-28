/**
 * What a pull request's state means on screen: the state its glyph shows, the
 * CI chip, whether the branch row offers Merge or Mark ready, why auto-merge
 * can't be changed, and the words for GitHub's refusals. Pure, so the window,
 * the sidebar and the main process read it alike.
 */
import type {
  GitHubProblem,
  GitHubPullRequest,
  PullRequestActionReason,
  PullRequestCheckCounts,
  PullRequestChecks,
  PullRequestState,
} from "./github-api";

/**
 * The glyph's state: an open request that has changes requested, conflicts
 * or an approval reads as that; otherwise its lifecycle state (shared-18
 * `_T`/`gT`). "none" is a session without a pull request.
 */
export type PullRequestDisplayState =
  PullRequestState | "approved" | "changesRequested" | "conflicting" | "none";

export function pullRequestDisplayState(
  pr: Pick<GitHubPullRequest, "state" | "review" | "conflicting"> | undefined,
): PullRequestDisplayState {
  if (!pr) return "none";
  if (pr.state === "open") {
    if (pr.review === "changesRequested") return "changesRequested";
    if (pr.conflicting) return "conflicting";
    if (pr.review === "approved") return "approved";
  }
  return pr.state;
}

/** The state in a word (the glyph's tooltip and the sidebar's). */
export const displayStateLabels: Record<PullRequestDisplayState, string> = {
  none: "No pull request",
  open: "Open",
  draft: "Draft",
  approved: "Approved",
  changesRequested: "Changes requested",
  conflicting: "Merge conflicts",
  queued: "Queued",
  merged: "Merged",
  closed: "Closed",
};

/** The request can still change (it is asked about again). */
export const pullRequestIsLive = (pr: GitHubPullRequest | undefined) =>
  !pr || (pr.state !== "merged" && pr.state !== "closed");

/** The sidebar row's tooltip: "#12 · Approved" (shared-18 `Dw`). */
export function pullRequestRowLabel(
  state: PullRequestDisplayState,
  numbers: number[],
  label: (text: string) => string = (text) => text,
) {
  const word = label(displayStateLabels[state]);
  return state === "none" || numbers.length === 0
    ? word
    : `${numbers.map((n) => `#${n}`).join(", ")} · ${word}`;
}

/**
 * The CI chip's state: "unavailable" when the request has no checks, or when a
 * merged or closed one's checks never finished.
 */
export type CiStatus = Exclude<PullRequestChecks, "none"> | "unavailable";

export function ciStatus(
  pr: GitHubPullRequest | undefined,
): CiStatus | undefined {
  if (!pr) return undefined;
  if (pr.checks === "none") return "unavailable";
  if (!pullRequestIsLive(pr) && pr.checks === "pending") return "unavailable";
  return pr.checks;
}

/** The CI chip's name for readers and its tooltip. */
export const ciLabels: Record<CiStatus, string> = {
  passed: "CI: all checks passed",
  failed: "CI: checks failing",
  pending: "CI: checks in progress",
  skipped: "CI: all checks skipped",
  unavailable: "CI: status unavailable",
};

/**
 * The CI chip's name with its counts: failing checks and skipped checks are
 * counted; every other state, or a state without counts, reads as `ciLabels`.
 */
export function ciChipLabel(
  status: CiStatus,
  counts: PullRequestCheckCounts | undefined,
): string {
  if (status === "failed" && counts && counts.failed > 0)
    return counts.failed === 1
      ? "CI: 1 check failing"
      : `CI: ${counts.failed} checks failing`;
  if (status === "skipped" && counts && counts.skipped > 0)
    return counts.skipped === 1
      ? "CI: 1 check skipped"
      : `CI: ${counts.skipped} checks skipped`;
  return ciLabels[status];
}

const failedConclusions = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
  "error",
]);

/**
 * One check of the head commit, as GitHub's check runs and commit statuses
 * report it: a check run has a status and (once completed) a conclusion; a
 * commit status has only a state.
 */
export interface CheckEntry {
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

/** Each check counted by state (the CI popover's rows). */
export function countChecks(entries: CheckEntry[]): PullRequestCheckCounts {
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 };
  for (const entry of entries) {
    const conclusion = entry.conclusion?.toLowerCase();
    const status = entry.status?.toLowerCase();
    const state = entry.state?.toLowerCase();
    if (state !== undefined && status === undefined) {
      // A commit status: success, failure, error or pending.
      if (state === "success") counts.passed++;
      else if (state === "pending" || state === "expected") counts.pending++;
      else counts.failed++;
    } else if (status !== "completed") counts.pending++;
    else if (conclusion && failedConclusions.has(conclusion)) counts.failed++;
    else if (conclusion === "skipped") counts.skipped++;
    else counts.passed++;
  }
  return counts;
}

/** The CI dot from the counts: failing beats running beats passed. */
export function checksFromCounts(
  counts: PullRequestCheckCounts,
): PullRequestChecks {
  if (counts.failed) return "failed";
  if (counts.pending) return "pending";
  if (counts.passed) return "passed";
  if (counts.skipped) return "skipped";
  return "none";
}

/**
 * Whether the row offers Merge: an open request that is approved, whose checks
 * all passed, that the account may merge, without auto-merge or a merge queue
 * (GitHub merges those itself).
 */
export function offersMerge(pr: GitHubPullRequest | undefined) {
  return Boolean(
    pr &&
    pullRequestDisplayState(pr) === "approved" &&
    pr.checks === "passed" &&
    pr.canMerge !== false &&
    !pr.autoMerge &&
    !pr.mergeQueue,
  );
}

/** Why a fresh read stops a merge. */
export type MergeHold =
  | "queued"
  | "merged"
  | "closed"
  | "draft"
  | "conflicting"
  | "armed"
  | "blocked"
  | "behind";

/**
 * Reads the request again just before merging: undefined when it can still
 * be merged as the person saw it, else what changed.
 */
export function mergeHold(pr: GitHubPullRequest): MergeHold | undefined {
  if (pr.state === "queued") return "queued";
  if (pr.state === "merged" || pr.state === "closed" || pr.state === "draft")
    return pr.state;
  if (pr.conflicting) return "conflicting";
  if (pr.autoMerge) return "armed";
  if (pr.mergeState === "blocked") return "blocked";
  if (pr.mergeState === "behind") return "behind";
  return undefined;
}

/** What the row says when a merge is held back. */
export function mergeHoldMessage(hold: MergeHold, base?: string) {
  switch (hold) {
    case "armed":
      return "Already set to merge when ready.";
    case "blocked":
      return "GitHub is blocking this merge. See what the pull request needs.";
    case "behind":
      return base
        ? `This branch is behind ${base}. Update it before you merge.`
        : "This branch is behind its base branch. Update it before you merge.";
    default:
      return "The pull request changed. See what changed before you merge.";
  }
}

/**
 * Why Auto-merge when ready can't be turned on here: a draft, a request GitHub
 * would merge right away, or an SSH session.
 */
export function autoMergeBlock(
  pr: GitHubPullRequest,
  ssh: boolean,
): string | undefined {
  if (ssh)
    return "Auto-merge isn’t available in SSH sessions yet. Use gh or GitHub directly.";
  if (pr.autoMerge) return undefined;
  if (pr.state === "draft") return "Draft PRs can’t use auto-merge.";
  if (
    (pr.mergeState === "clean" || pr.mergeState === "unstable") &&
    !pr.mergeQueue
  )
    return "PR is ready to merge now — nothing to wait for.";
  return undefined;
}

/** GitHub's and `gh`'s refusals by their words. */
const reasonPatterns: [PullRequestActionReason, RegExp][] = [
  ["rate_limited", /rate limit|abuse detection/i],
  ["pr_closed", /is already merged|Pull request is closed/i],
  [
    "repo_disallows_auto_merge",
    /auto[- ]?merge is not allowed for this repository|Check that "Allow auto-merge" is enabled/i,
  ],
  ["already_mergeable", /clean status|unstable status/i],
  ["merge_method_not_allowed", /merge method .*not allowed/i],
  [
    "no_branch_protection",
    /protected branch rules not configured|does not have required protected branch rules/i,
  ],
  ["stacked_pr", /stacked pull request/i],
  [
    "no_permission",
    /does not have the correct permissions to execute|not authorized for this protected branch|Resource not accessible|must have (push|write|admin) access/i,
  ],
  ["workflow_scope", /without `?workflow`? scope/i],
  ["head_moved", /Head branch was modified|head commit .* does not match/i],
  ["not_found", /Pull request (#\d+ )?not found|Could not resolve to a/i],
  [
    "already_in_state",
    /already enabled|already disabled|Auto merge is not enabled|may not currently be enabled|is already "ready for review"|already a draft/i,
  ],
  [
    "network",
    /ETIMEDOUT|ENOTFOUND|ECONNRE|EAI_AGAIN|socket hang up|error connecting to|i\/o timeout|HTTP 5\d\d/i,
  ],
];

export function actionReason(text: string): PullRequestActionReason {
  for (const [reason, pattern] of reasonPatterns)
    if (pattern.test(text)) return reason;
  return "unknown";
}

/** GitHub's own words, cut to 200 characters at a word. */
export function actionDetail(text: string): string | undefined {
  const line = text
    .trim()
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return undefined;
  const clean = line.replace(/^(gh: |GraphQL: |error: )/i, "");
  if (clean.length <= 200) return clean;
  const cut = clean.slice(0, 200);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

/** Auto-merge's refusals in the original's words. */
const autoMergeMessages: Partial<Record<PullRequestActionReason, string>> = {
  repo_disallows_auto_merge:
    "This repository doesn’t allow auto-merge. An admin can turn on Allow auto-merge in the repository settings on GitHub.",
  already_mergeable:
    "This pull request is ready to merge now, so there’s nothing for auto-merge to wait for.",
  merge_method_not_allowed:
    "This repository doesn’t allow squash merging, which auto-merge uses here. Turn on auto-merge on GitHub to pick an allowed merge method.",
  no_branch_protection:
    "GitHub only offers auto-merge on protected base branches, and this one isn’t protected. An admin can add a branch protection rule on GitHub.",
  stacked_pr: "GitHub doesn’t support auto-merge on stacked pull requests.",
  no_permission:
    "Your GitHub account doesn’t have permission to change auto-merge on this repository. Ask a repository admin for access.",
  workflow_scope:
    "This pull request changes a workflow file, and your GitHub CLI sign-in lacks the workflow scope. Run gh auth refresh -s workflow to add it.",
  pr_closed: "This pull request is already merged or closed.",
  not_found:
    "Couldn’t find this pull request on GitHub. Check that your GitHub account has access to the repository.",
  gh_auth: "GitHub CLI isn’t signed in. Run gh auth login to sign in.",
  gh_unavailable:
    "GitHub CLI (gh) isn’t installed or didn’t start, so auto-merge can’t be changed from here.",
  network: "Couldn’t reach GitHub. Check your connection and try again.",
  rate_limited:
    "Couldn’t change auto-merge. GitHub’s rate limit lifts within the hour, so try again after that.",
};

/** What a failed change says (a toast). */
export function actionFailureMessage(
  action: "merge" | "autoMergeOn" | "autoMergeOff" | "ready" | "draft",
  reason: PullRequestActionReason | undefined,
  detail?: string,
): string {
  if (action === "merge") return "Couldn’t merge the pull request.";
  if (action === "ready")
    return "Couldn’t mark the pull request ready for review. Try again or use GitHub.";
  if (action === "draft")
    return "Couldn’t convert the pull request to draft. Try again or use GitHub.";
  if (reason === "already_in_state")
    return action === "autoMergeOn"
      ? "Auto-merge is already on for this pull request."
      : "Auto-merge is already off for this pull request.";
  const known = reason && autoMergeMessages[reason];
  if (known) return known;
  return detail
    ? `Couldn’t change auto-merge: ${detail}`
    : "Couldn’t change auto-merge from here.";
}

/** What a change that went through announces. */
export const actionAnnouncements = {
  merged: "Pull request merged.",
  queued: "Added to the merge queue.",
  ready: "Marked ready for review.",
  draft: "Converted to draft.",
  autoMergeOn: "Set to merge when ready.",
  autoMergeOff: "Auto-merge canceled.",
} as const;

/**
 * The row's warning when GitHub couldn't be asked: the last state shown may be
 * out of date.
 */
export function problemWarning(problem: GitHubProblem) {
  switch (problem) {
    case "rate-limited":
      return "GitHub API rate limit reached. Pull request status may be out of date until the limit resets.";
    case "cli-signed-out":
      return "GitHub CLI authentication expired. Run gh auth login to refresh pull request status.";
    case "network":
      return "GitHub is unreachable. Pull request status may be out of date.";
    default:
      return "Pull request status couldn’t be checked and may be out of date.";
  }
}

/**
 * Ask Claude to fix a request's conflicts: merge the base branch in, resolve
 * and push.
 */
export function conflictFixPrompt(number: number, url: string) {
  return `PR #${number} (${url}) has merge conflicts with its base branch. Merge the base branch in, resolve the conflicts, and push.`;
}

/** GitHub's checks page of a request. */
export function checksUrl(pr: Pick<GitHubPullRequest, "url">) {
  return /\/pull\/\d+$/.test(pr.url) ? `${pr.url}/checks` : pr.url;
}
