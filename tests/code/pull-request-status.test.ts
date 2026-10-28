/**
 * A pull request's state on screen: the glyph's state, the CI chip, when the
 * branch row offers Merge, why auto-merge can't change, GitHub's refusals in
 * words, the sidebar row's PR status, the service's answers, and the window's
 * shared store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { GitHubPullRequest } from "../../shared/github-api";
import {
  actionDetail,
  actionFailureMessage,
  actionReason,
  autoMergeBlock,
  checksFromCounts,
  checksUrl,
  ciChipLabel,
  ciLabels,
  ciStatus,
  conflictFixPrompt,
  countChecks,
  mergeHold,
  mergeHoldMessage,
  offersMerge,
  problemWarning,
  pullRequestDisplayState,
  pullRequestRowLabel,
} from "../../shared/pull-request-status";
import {
  parseGitHubPullRequest,
  parsePullRequestAction,
} from "../../shared/github-parse";
import { rowStatus } from "../../src/sidebar/row-status";

const pr = (patch: Partial<GitHubPullRequest> = {}): GitHubPullRequest => ({
  number: 7,
  url: "https://github.com/octo/hello/pull/7",
  repository: "octo/hello",
  title: "T",
  state: "open",
  checks: "passed",
  baseRef: "main",
  headRef: "feature",
  headSha: "0123456789abcdef",
  review: "approved",
  conflicting: false,
  mergeState: "clean",
  autoMerge: false,
  mergeQueue: false,
  canMerge: true,
  ...patch,
});

test("the glyph's state weighs reviews and conflicts only while open", () => {
  assert.equal(pullRequestDisplayState(undefined), "none");
  assert.equal(pullRequestDisplayState(pr()), "approved");
  assert.equal(
    pullRequestDisplayState(
      pr({ review: "changesRequested", conflicting: true }),
    ),
    "changesRequested",
  );
  assert.equal(
    pullRequestDisplayState(pr({ conflicting: true })),
    "conflicting",
  );
  assert.equal(pullRequestDisplayState(pr({ review: undefined })), "open");
  assert.equal(
    pullRequestDisplayState(pr({ state: "draft", conflicting: true })),
    "draft",
  );
  for (const state of ["queued", "merged", "closed"] as const)
    assert.equal(pullRequestDisplayState(pr({ state })), state);
  assert.equal(pullRequestRowLabel("approved", [7]), "#7 · Approved");
  assert.equal(pullRequestRowLabel("none", [7]), "No pull request");
});

test("the CI chip reads unavailable without checks or with a settled request's unfinished ones", () => {
  assert.equal(ciStatus(pr()), "passed");
  assert.equal(ciStatus(pr({ checks: "none" })), "unavailable");
  assert.equal(ciStatus(pr({ state: "merged" })), "passed");
  assert.equal(
    ciStatus(pr({ state: "closed", checks: "pending" })),
    "unavailable",
  );
  assert.equal(ciLabels.unavailable, "CI: status unavailable");
  assert.equal(ciStatus(undefined), undefined);
  const counts = countChecks([
    { status: "completed", conclusion: "success" },
    { status: "COMPLETED", conclusion: "TIMED_OUT" },
    { status: "in_progress" },
    { status: "completed", conclusion: "skipped" },
    { state: "PENDING" },
    { state: "SUCCESS" },
  ]);
  assert.deepEqual(counts, { passed: 2, failed: 1, pending: 2, skipped: 1 });
  assert.equal(checksFromCounts(counts), "failed");
  assert.equal(
    checksFromCounts({ passed: 0, failed: 0, pending: 0, skipped: 2 }),
    "skipped",
  );
  assert.equal(
    checksFromCounts({ passed: 0, failed: 0, pending: 0, skipped: 0 }),
    "none",
  );
  assert.equal(checksUrl(pr()), "https://github.com/octo/hello/pull/7/checks");
});

test("the CI chip's name counts failing and skipped checks", () => {
  const counts = { passed: 3, failed: 2, pending: 0, skipped: 1 };
  assert.equal(ciChipLabel("failed", counts), "CI: 2 checks failing");
  assert.equal(
    ciChipLabel("failed", { ...counts, failed: 1 }),
    "CI: 1 check failing",
  );
  assert.equal(ciChipLabel("skipped", counts), "CI: 1 check skipped");
  assert.equal(ciChipLabel("failed", undefined), "CI: checks failing");
  assert.equal(ciChipLabel("passed", counts), "CI: all checks passed");
  assert.equal(ciChipLabel("pending", counts), "CI: checks in progress");
});

test("Merge is offered for an approved request whose checks passed, and held when it changed", () => {
  assert.equal(offersMerge(pr()), true);
  assert.equal(offersMerge(pr({ checks: "pending" })), false);
  assert.equal(offersMerge(pr({ review: "reviewRequired" })), false);
  assert.equal(offersMerge(pr({ canMerge: false })), false);
  assert.equal(offersMerge(pr({ autoMerge: true })), false);
  assert.equal(offersMerge(pr({ mergeQueue: true })), false);
  assert.equal(offersMerge(undefined), false);

  assert.equal(mergeHold(pr()), undefined);
  assert.equal(mergeHold(pr({ state: "merged" })), "merged");
  assert.equal(mergeHold(pr({ conflicting: true })), "conflicting");
  assert.equal(mergeHold(pr({ autoMerge: true })), "armed");
  assert.equal(mergeHold(pr({ mergeState: "blocked" })), "blocked");
  assert.equal(mergeHold(pr({ mergeState: "behind" })), "behind");
  assert.equal(
    mergeHoldMessage("behind", "main"),
    "This branch is behind main. Update it before you merge.",
  );
  assert.equal(
    mergeHoldMessage("merged"),
    "The pull request changed. See what changed before you merge.",
  );
});

test("auto-merge says why it can't change: SSH, a draft, nothing to wait for", () => {
  assert.equal(
    autoMergeBlock(pr(), false),
    "PR is ready to merge now — nothing to wait for.",
  );
  assert.equal(autoMergeBlock(pr({ mergeState: "blocked" }), false), undefined);
  assert.equal(
    autoMergeBlock(pr({ mergeState: "clean", mergeQueue: true }), false),
    undefined,
  );
  assert.equal(
    autoMergeBlock(pr({ state: "draft", mergeState: "draft" }), false),
    "Draft PRs can’t use auto-merge.",
  );
  // A request with auto-merge on can always turn it off.
  assert.equal(autoMergeBlock(pr({ autoMerge: true }), false), undefined);
  assert.match(autoMergeBlock(pr(), true)!, /SSH sessions/);
});

test("GitHub's refusals read as the original's words", () => {
  assert.equal(
    actionReason("Pull request Auto merge is not allowed for this repository"),
    "repo_disallows_auto_merge",
  );
  assert.equal(actionReason("API rate limit exceeded"), "rate_limited");
  assert.equal(
    actionReason("Pull request is in clean status"),
    "already_mergeable",
  );
  assert.equal(
    actionReason(
      "refusing to allow an OAuth App to create or update workflow without `workflow` scope",
    ),
    "workflow_scope",
  );
  assert.equal(actionReason("odd"), "unknown");
  assert.equal(actionDetail("x\ngh: no way"), "no way");
  assert.equal(actionDetail("a ".repeat(150))!.endsWith("…"), true);
  assert.match(
    actionFailureMessage("autoMergeOn", "repo_disallows_auto_merge"),
    /doesn’t allow auto-merge/,
  );
  assert.equal(
    actionFailureMessage("autoMergeOff", "already_in_state"),
    "Auto-merge is already off for this pull request.",
  );
  assert.equal(
    actionFailureMessage("autoMergeOn", "unknown", "nope"),
    "Couldn’t change auto-merge: nope",
  );
  assert.equal(
    actionFailureMessage("merge", "unknown"),
    "Couldn’t merge the pull request.",
  );
  assert.match(problemWarning("rate-limited"), /rate limit/);
  assert.match(problemWarning("unavailable"), /couldn’t be checked/);
  assert.equal(
    conflictFixPrompt(7, "https://github.com/octo/hello/pull/7"),
    "PR #7 (https://github.com/octo/hello/pull/7) has merge conflicts with its base branch. Merge the base branch in, resolve the conflicts, and push.",
  );
});

test("a sidebar row shows its pull request in place of the dot", () => {
  const code = {
    mode: "code" as const,
    archived: false,
    unread: false,
    turns: [],
  };
  const idle = { working: false, needsApproval: false, question: false };
  const approved = rowStatus(code, idle, { state: "approved", number: 7 });
  assert.equal(approved.pr, "approved");
  assert.equal(approved.label, "#7 · Approved");
  // Working and waiting come first; an unread reply beats an open request,
  // not a merged one.
  assert.equal(
    rowStatus(code, { ...idle, working: true }, { state: "open", number: 7 })
      .pr,
    undefined,
  );
  const unread = { ...code, unread: true };
  assert.equal(
    rowStatus(unread, idle, { state: "open", number: 7 }).dot,
    "unread",
  );
  assert.equal(
    rowStatus(unread, idle, { state: "merged", number: 7 }).pr,
    "merged",
  );
  // No pull request, a Chat, or an archived session: the usual dot.
  assert.equal(
    rowStatus(code, idle, { state: "none", number: 7 }).pr,
    undefined,
  );
  assert.equal(
    rowStatus({ ...code, mode: "chat" }, idle, { state: "open", number: 7 }).pr,
    undefined,
  );
  assert.equal(
    rowStatus({ ...code, archived: true }, idle, { state: "open", number: 7 })
      .archived,
    true,
  );
});

test("the service's pull request and its answers to changes are read defensively", () => {
  const parsed = parseGitHubPullRequest(
    {
      number: 7,
      url: "https://github.com/octo/hello/pull/7",
      title: "T",
      state: "queued",
      checks: "pending",
      check_counts: { passed: 1, failed: 0, pending: 2, skipped: 0 },
      base_ref: "main",
      head_ref: "feature",
      head_sha: "0123456789abcdef",
      review: "changes_requested",
      conflicting: false,
      merge_state: "BLOCKED",
      auto_merge: true,
      merge_queue: true,
      auto_merge_allowed: true,
      merge_method: "rebase",
      can_merge: false,
      additions: 4,
      deletions: 1,
    },
    "octo/hello",
  );
  assert.deepEqual(parsed, {
    number: 7,
    url: "https://github.com/octo/hello/pull/7",
    repository: "octo/hello",
    title: "T",
    state: "queued",
    checks: "pending",
    checkCounts: { passed: 1, failed: 0, pending: 2, skipped: 0 },
    baseRef: "main",
    body: "",
    headRef: "feature",
    headSha: "0123456789abcdef",
    review: "changesRequested",
    conflicting: false,
    mergeState: "blocked",
    autoMerge: true,
    mergeQueue: true,
    autoMergeAllowed: true,
    mergeMethod: "rebase",
    canMerge: false,
    additions: 4,
    deletions: 1,
  });
  // An older service's "conflicting" is an open request with conflicts.
  const legacy = parseGitHubPullRequest(
    {
      number: 7,
      url: "https://github.com/octo/hello/pull/7",
      state: "conflicting",
    },
    "octo/hello",
  )!;
  assert.equal(legacy.state, "open");
  assert.equal(legacy.conflicting, true);
  assert.equal(legacy.checkCounts, undefined);
  assert.equal(
    parseGitHubPullRequest(
      { number: 7, url: "x", state: "weird" },
      "octo/hello",
    ),
    null,
  );

  assert.deepEqual(parsePullRequestAction({ ok: true, queued: true }), {
    ok: true,
    queued: true,
  });
  assert.deepEqual(parsePullRequestAction({ reason: "head_moved" }), {
    ok: false,
    reason: "head_moved",
  });
  assert.deepEqual(parsePullRequestAction({ reason: "made-up", detail: "d" }), {
    ok: false,
    reason: "unknown",
    detail: "d",
  });
});

test("the window's store asks once per request and tells when one settles", async () => {
  const asked: number[] = [];
  let state: GitHubPullRequest["state"] = "open";
  (globalThis as { window?: unknown }).window = {
    desktop: {
      githubPullRequest: async ({ number }: { number: number }) => {
        asked.push(number);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { pullRequest: pr({ number, state }) };
      },
    },
  };
  const store = await import("../../src/pr/pr-status-store");
  store.resetPullRequestStore();
  const ref = {
    url: "https://github.com/octo/hello/pull/7",
    host: "github.com",
    repository: "Octo/Hello",
    number: 7,
  };
  const settled: string[] = [];
  const stop = store.onPullRequestSettled((key, after) =>
    settled.push(`${key}:${after.state}`),
  );
  await Promise.all([store.readPullRequest(ref), store.readPullRequest(ref)]);
  assert.deepEqual(asked, [7]);
  const key = store.pullRequestKey(ref);
  assert.equal(key, "octo/hello#7");
  assert.equal(store.pullRequestEntry(key).pr?.state, "open");
  state = "merged";
  await store.readPullRequest(ref);
  assert.deepEqual(settled, ["octo/hello#7:merged"]);
  // Another host is never asked about.
  await store.readPullRequest({ ...ref, host: "ghe.example", number: 8 });
  assert.deepEqual(asked, [7, 7]);
  stop();
  store.resetPullRequestStore();
});
