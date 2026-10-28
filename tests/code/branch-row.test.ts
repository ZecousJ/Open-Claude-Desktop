import test from "node:test";
import assert from "node:assert/strict";
import {
  prAction,
  pullRequestIsLive,
  rowAccent,
} from "../../src/pr/branch-row";
import type { CodeGitStatus } from "../../shared/panels-api";
import type { GitHubPullRequest } from "../../shared/github-api";

const status = (patch: Partial<CodeGitStatus> = {}): CodeGitStatus => ({
  state: "ready",
  branch: "feature",
  baseBranch: "main",
  repository: "octo/hello",
  ahead: 1,
  pushed: false,
  dirty: false,
  additions: 3,
  deletions: 1,
  ...patch,
});
const input = {
  cloud: false,
  running: false,
  mode: "create" as const,
  lookingUp: false,
};

test("Create PR works on a feature branch with something to open a request from", () => {
  assert.deepEqual(prAction({ ...input, status: status() }), {
    kind: "create",
    label: "Create PR",
    disabled: undefined,
  });
  assert.equal(
    prAction({ ...input, status: status(), mode: "draft" }).label,
    "Create draft PR",
  );
  assert.equal(
    prAction({ ...input, status: status(), mode: "compose" }).label,
    "Manually create PR",
  );
  // Uncommitted work alone is enough: Claude commits it first.
  assert.equal(
    prAction({ ...input, status: status({ ahead: 0, dirty: true }) }).disabled,
    undefined,
  );
});

test("it says why it is off, in the order the original checks", () => {
  const off = (patch: Partial<CodeGitStatus>, extra = {}) =>
    prAction({ ...input, ...extra, status: status(patch) }).disabled;
  assert.equal(
    off({ branch: "main" }),
    "Already on the base branch — check out a feature branch first",
  );
  assert.equal(
    off({ ahead: 0, dirty: false }),
    "No changes to create a PR from",
  );
  assert.equal(
    off({}, { running: true }),
    "Claudex is working — wait for the turn to finish",
  );
  assert.equal(
    off({}, { lookingUp: true }),
    "Checking for an existing pull request",
  );
  // A cloud session's branch has to be on GitHub; a local one is pushed then.
  assert.equal(off({}, { cloud: true }), "Branch hasn’t been pushed to GitHub");
  assert.equal(off({ pushed: true }, { cloud: true }), undefined);
  assert.equal(off({}), undefined);
  // A cloud session with no GitHub repository cannot create one.
  assert.equal(
    off({ repository: undefined }, { cloud: true }),
    "Add a GitHub remote to create a pull request",
  );
});

test("a folder without a GitHub remote commits instead", () => {
  const folder = status({ repository: undefined });
  assert.deepEqual(prAction({ ...input, status: folder }), {
    kind: "commit",
    label: "Commit changes",
    disabled: "No changes to commit",
  });
  const dirty = status({ repository: undefined, dirty: true });
  assert.equal(prAction({ ...input, status: dirty }).disabled, undefined);
  assert.equal(
    prAction({ ...input, status: dirty, running: true }).disabled,
    "Claudex is working — wait for the turn to finish",
  );
});

test("a merged or queued pull request tints the row; a settled one stops being asked about", () => {
  const pr = (state: GitHubPullRequest["state"]): GitHubPullRequest => ({
    number: 7,
    url: "https://github.com/octo/hello/pull/7",
    repository: "octo/hello",
    title: "T",
    state,
    checks: "none",
    baseRef: "main",
    headRef: "feature",
  });
  assert.equal(rowAccent(pr("merged")), "merged");
  assert.equal(rowAccent(pr("queued")), "queued");
  assert.equal(rowAccent(pr("open")), undefined);
  assert.equal(rowAccent(undefined), undefined);
  for (const state of ["open", "draft", "queued"] as const)
    assert.ok(pullRequestIsLive(pr(state)), state);
  for (const state of ["merged", "closed"] as const)
    assert.ok(!pullRequestIsLive(pr(state)), state);
  assert.ok(pullRequestIsLive(undefined));
});
