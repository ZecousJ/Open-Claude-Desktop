/**
 * Reading the service's issue and pull request answers (shared/github-api.ts
 * has the types), and checking a repository's name. Apart from the call
 * list because the web bridge loads it when one of those calls first runs.
 */
import type {
  GitHubIssue,
  GitHubIssueDetail,
  GitHubPullRequest,
  PullRequestActionReason,
  PullRequestActionResult,
  PullRequestCheckCounts,
  PullRequestChecks,
  PullRequestMergeMethod,
  PullRequestReview,
  PullRequestState,
} from "./github-api";

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

function issueRow(value: unknown, repository: string): GitHubIssue | undefined {
  const json = record(value);
  const number = json.number;
  const title = text(json.title);
  const url = text(json.url);
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1)
    return undefined;
  if (!title || !url) return undefined;
  const labels = Array.isArray(json.labels)
    ? json.labels.filter((label): label is string => typeof label === "string")
    : [];
  return {
    number,
    title,
    state: json.state === "closed" ? "closed" : "open",
    repository: text(json.repository) || repository,
    url,
    labels,
  };
}

export function parseGitHubIssues(
  value: unknown,
  repository: string,
): GitHubIssue[] {
  const json = record(value);
  const items = Array.isArray(json.items) ? json.items : [];
  return items.flatMap((item) => issueRow(item, repository) ?? []);
}

export function parseGitHubIssue(
  value: unknown,
  repository: string,
): GitHubIssueDetail | null {
  const base = issueRow(value, repository);
  if (!base) return null;
  const json = record(value);
  return {
    ...base,
    body: text(json.body),
    author: text(json.author),
    authorAssociation: text(json.author_association),
  };
}

const pullStates: readonly PullRequestState[] = [
  "open",
  "draft",
  "queued",
  "merged",
  "closed",
];
const checkStates: readonly PullRequestChecks[] = [
  "passed",
  "failed",
  "pending",
  "skipped",
  "none",
];
const reviews: Record<string, PullRequestReview> = {
  approved: "approved",
  changes_requested: "changesRequested",
  review_required: "reviewRequired",
};
const methods: readonly PullRequestMergeMethod[] = [
  "merge",
  "squash",
  "rebase",
];
const tally = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;

function checkCounts(value: unknown): PullRequestCheckCounts | undefined {
  const json = record(value);
  const passed = tally(json.passed);
  const failed = tally(json.failed);
  const pending = tally(json.pending);
  const skipped = tally(json.skipped);
  return passed === undefined ||
    failed === undefined ||
    pending === undefined ||
    skipped === undefined
    ? undefined
    : { passed, failed, pending, skipped };
}

/**
 * The service's pull request (internal/claudex/ghconn/work.go). An older
 * service says "conflicting" for the state: an open request with conflicts.
 */
export function parseGitHubPullRequest(
  value: unknown,
  repository: string,
): GitHubPullRequest | null {
  const json = record(value);
  const number = json.number;
  const url = text(json.url);
  const legacyConflict = json.state === "conflicting";
  const state = legacyConflict
    ? "open"
    : pullStates.find((candidate) => candidate === json.state);
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1)
    return null;
  if (!url || !state) return null;
  const counts = checkCounts(json.check_counts);
  const headSha = text(json.head_sha);
  const review = reviews[text(json.review)];
  const mergeState = text(json.merge_state).toLowerCase();
  const method = methods.find((candidate) => candidate === json.merge_method);
  const additions = tally(json.additions);
  const deletions = tally(json.deletions);
  return {
    number,
    url,
    repository: text(json.repository) || repository,
    title: text(json.title),
    body: text(json.body),
    state,
    checks:
      checkStates.find((candidate) => candidate === json.checks) ?? "none",
    ...(counts ? { checkCounts: counts } : {}),
    baseRef: text(json.base_ref),
    headRef: text(json.head_ref),
    ...(/^[0-9a-f]{7,64}$/i.test(headSha) ? { headSha } : {}),
    ...(review ? { review } : {}),
    conflicting: legacyConflict || json.conflicting === true,
    ...(mergeState ? { mergeState } : {}),
    autoMerge: json.auto_merge === true,
    mergeQueue: json.merge_queue === true,
    autoMergeAllowed: json.auto_merge_allowed === true,
    ...(method ? { mergeMethod: method } : {}),
    ...(typeof json.can_merge === "boolean"
      ? { canMerge: json.can_merge }
      : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
  };
}

const actionReasons: readonly PullRequestActionReason[] = [
  "rate_limited",
  "pr_closed",
  "repo_disallows_auto_merge",
  "already_mergeable",
  "merge_method_not_allowed",
  "no_branch_protection",
  "stacked_pr",
  "no_permission",
  "workflow_scope",
  "not_found",
  "gh_unavailable",
  "gh_auth",
  "not_connected",
  "already_in_state",
  "head_moved",
  "network",
  "unknown",
];

/** The service's answer to a change (POST .../web/github/pull/action). */
export function parsePullRequestAction(
  value: unknown,
): PullRequestActionResult {
  const json = record(value);
  if (json.ok === true)
    return { ok: true, ...(json.queued === true ? { queued: true } : {}) };
  const reason =
    actionReasons.find((candidate) => candidate === json.reason) ?? "unknown";
  const detail = text(json.detail).slice(0, 300);
  return { ok: false, reason, ...(detail ? { detail } : {}) };
}

/** Whether a name is "owner/name" with the characters GitHub allows. */
export function validRepositoryName(value: string) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(
    value,
  );
}
