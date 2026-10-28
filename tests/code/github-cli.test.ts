/**
 * GitHub through the machine's `gh` (electron/github-cli.ts), with a fake
 * runner standing in for the CLI: the arguments it is given, and how its
 * answers and failures read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getIssue,
  getPullRequest,
  issueSearch,
  listIssues,
  problemOf,
  pullRequestAction,
  pullRequestActionArgs,
  type GhResult,
  type GhRunner,
} from "../../electron/git/github-cli";

const ok = (value: unknown): GhResult => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: "",
});
const fail = (stderr: string): GhResult => ({ code: 1, stdout: "", stderr });

/** A runner that answers by the endpoint (the last argument) and records calls. */
function fake(answers: Record<string, GhResult>) {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    return answers[args.at(-1)!] ?? fail("gh: Not Found (HTTP 404)");
  };
  return { run, calls };
}
const issue = (number: number, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  state: "open",
  html_url: `https://github.com/octo/hello/issues/${number}`,
  labels: [{ name: "bug" }, "plain"],
  ...extra,
});

test("the list asks for what involves the person until they type", async () => {
  assert.equal(
    issueSearch("octo/hello", ""),
    "repo:octo/hello is:issue is:open involves:@me",
  );
  assert.equal(
    issueSearch("octo/hello", "  slow\n list "),
    "repo:octo/hello is:issue is:open slow list",
  );
  const { run, calls } = fake({
    "search/issues": ok({ items: [issue(1), issue(2, { pull_request: {} })] }),
  });
  const result = await listIssues("octo/hello", undefined, run);
  // gh api GET with the query as a field; a pull request among the hits is not an issue.
  assert.deepEqual(calls[0].slice(0, 3), ["api", "--method", "GET"]);
  assert.ok(
    calls[0].includes("q=repo:octo/hello is:issue is:open involves:@me"),
  );
  assert.deepEqual(
    result.items.map((item) => [item.number, item.labels]),
    [[1, ["bug", "plain"]]],
  );
});

test("a number finds that open issue first, and a pull request or a closed issue adds nothing", async () => {
  const search = ok({ items: [issue(12), issue(14)] });
  const found = fake({
    "search/issues": search,
    "repos/octo/hello/issues/14": ok(issue(14)),
  });
  assert.deepEqual(
    (await listIssues("octo/hello", "#14", found.run)).items.map(
      (i) => i.number,
    ),
    [14, 12],
  );
  for (const direct of [
    ok(issue(14, { pull_request: {} })),
    ok(issue(14, { state: "closed" })),
  ]) {
    const other = fake({
      "search/issues": search,
      "repos/octo/hello/issues/14": direct,
    });
    assert.deepEqual(
      (await listIssues("octo/hello", "14", other.run)).items.map(
        (i) => i.number,
      ),
      [12, 14],
    );
  }
});

test("a missing or signed-out CLI is named, an unknown repository is not an error", async () => {
  assert.equal(
    problemOf({ code: 127, stdout: "", stderr: "", missing: true }),
    "cli-missing",
  );
  assert.equal(
    problemOf(
      fail("To get started with GitHub CLI, please run:  gh auth login"),
    ),
    "cli-signed-out",
  );
  assert.equal(
    problemOf(fail("gh: Bad credentials (HTTP 401)")),
    "cli-signed-out",
  );
  assert.equal(problemOf(fail("gh: Not Found (HTTP 404)")), "not-found");
  assert.equal(problemOf(fail("connection reset")), "unavailable");

  const missing = await listIssues("octo/hello", undefined, async () => ({
    code: 127,
    stdout: "",
    stderr: "",
    missing: true,
  }));
  assert.deepEqual(missing, { items: [], problem: "cli-missing" });
  const signedOut = await listIssues("octo/hello", undefined, async () =>
    fail("gh auth login required"),
  );
  assert.equal(signedOut.problem, "cli-signed-out");
  // The search failing on an unreadable answer is "unavailable", not a crash.
  const garbage = await listIssues("octo/hello", undefined, async () => ({
    code: 0,
    stdout: "not json",
    stderr: "",
  }));
  assert.equal(garbage.problem, "unavailable");
});

test("only owner/name repositories reach gh", async () => {
  const { run, calls } = fake({});
  for (const bad of [
    "",
    "octo",
    "octo/hello/extra",
    "-x/y",
    "octo/../etc",
    "a b/c",
  ]) {
    assert.deepEqual(await listIssues(bad, "x", run), { items: [] });
    assert.equal(await getIssue(bad, 1, run), null);
    assert.deepEqual(await getPullRequest(bad, 1, run), { pullRequest: null });
  }
  assert.equal(await getIssue("octo/hello", 0, run), null);
  assert.equal(calls.length, 0);
});

test("an issue carries its text and author; a pull request is not an issue", async () => {
  const { run } = fake({
    "repos/octo/hello/issues/5": ok(
      issue(5, {
        body: "Steps",
        user: { login: "octo" },
        author_association: "OWNER",
      }),
    ),
    "repos/octo/hello/issues/6": ok(issue(6, { pull_request: {} })),
  });
  assert.deepEqual(await getIssue("octo/hello", 5, run), {
    number: 5,
    title: "Issue 5",
    state: "open",
    repository: "octo/hello",
    url: "https://github.com/octo/hello/issues/5",
    labels: ["bug", "plain"],
    body: "Steps",
    author: "octo",
    authorAssociation: "OWNER",
  });
  assert.equal(await getIssue("octo/hello", 6, run), null);
  assert.equal(await getIssue("octo/hello", 7, run), null);
});

/** GraphQL's answer for an open, approved request whose one check passed. */
const graphRepo = (patch: Record<string, unknown> = {}) => ({
  viewerPermission: "WRITE",
  autoMergeAllowed: true,
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: false,
  viewerDefaultMergeMethod: "REBASE",
  pullRequest: {
    number: 7,
    url: "https://github.com/octo/hello/pull/7",
    title: "Add a thing",
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    isInMergeQueue: false,
    isMergeQueueEnabled: false,
    additions: 12,
    deletions: 3,
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: "0123456789abcdef",
    autoMergeRequest: null,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  {
                    __typename: "CheckRun",
                    status: "COMPLETED",
                    conclusion: "SUCCESS",
                  },
                ],
              },
            },
          },
        },
      ],
    },
    ...patch,
  },
});

test("a pull request is read in one GraphQL call with its reviews, conflicts and checks", async () => {
  const calls: string[][] = [];
  let repo: unknown = graphRepo();
  const run: GhRunner = async (args) => {
    calls.push(args);
    return ok({ data: { repository: repo } });
  };
  assert.deepEqual(await getPullRequest("octo/hello", 7, run), {
    pullRequest: {
      number: 7,
      url: "https://github.com/octo/hello/pull/7",
      repository: "octo/hello",
      title: "Add a thing",
      state: "open",
      checks: "passed",
      checkCounts: { passed: 1, failed: 0, pending: 0, skipped: 0 },
      baseRef: "main",
      body: "",
      headRef: "feature",
      headSha: "0123456789abcdef",
      review: "approved",
      conflicting: false,
      mergeState: "clean",
      autoMerge: false,
      mergeQueue: false,
      autoMergeAllowed: true,
      // The account's default (rebase) isn't allowed here.
      mergeMethod: "squash",
      canMerge: true,
      additions: 12,
      deletions: 3,
    },
  });
  // owner and name go as strings (-f), the number as a number (-F).
  assert.deepEqual(calls[0]!.slice(0, 2), ["api", "graphql"]);
  assert.deepEqual(calls[0]!.slice(-6), [
    "-f",
    "owner=octo",
    "-f",
    "name=hello",
    "-F",
    "number=7",
  ]);

  repo = graphRepo({
    mergeable: "CONFLICTING",
    reviewDecision: "CHANGES_REQUESTED",
    autoMergeRequest: { enabledAt: "2026-10-12" },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { __typename: "CheckRun", status: "IN_PROGRESS" },
                  {
                    __typename: "CheckRun",
                    status: "COMPLETED",
                    conclusion: "SKIPPED",
                  },
                  { __typename: "StatusContext", state: "FAILURE" },
                ],
              },
            },
          },
        },
      ],
    },
  });
  const busy = (await getPullRequest("octo/hello", 7, run)).pullRequest!;
  assert.equal(busy.conflicting, true);
  assert.equal(busy.review, "changesRequested");
  assert.equal(busy.autoMerge, true);
  assert.equal(busy.checks, "failed");
  assert.deepEqual(busy.checkCounts, {
    passed: 0,
    failed: 1,
    pending: 1,
    skipped: 1,
  });

  repo = graphRepo({ isDraft: true });
  assert.equal(
    (await getPullRequest("octo/hello", 7, run)).pullRequest?.state,
    "draft",
  );
  repo = graphRepo({ isInMergeQueue: true });
  assert.equal(
    (await getPullRequest("octo/hello", 7, run)).pullRequest?.state,
    "queued",
  );
  // Merged: final, its checks no longer show.
  repo = graphRepo({ state: "MERGED", merged: true });
  const merged = (await getPullRequest("octo/hello", 7, run)).pullRequest!;
  assert.equal(merged.state, "merged");
  assert.equal(merged.checks, "none");
  assert.equal(merged.checkCounts, undefined);

  // Unknown to this account: no pull request, and no problem to report.
  assert.deepEqual(
    await getPullRequest("octo/hello", 8, async () =>
      fail("GraphQL: Could not resolve to a PullRequest with the number of 8."),
    ),
    { pullRequest: null },
  );
  assert.equal(
    (await getPullRequest("octo/hello", 7, async () => fail("gh auth login")))
      .problem,
    "cli-signed-out",
  );
  assert.equal(
    (
      await getPullRequest("octo/hello", 7, async () =>
        fail("API rate limit exceeded for user"),
      )
    ).problem,
    "rate-limited",
  );
  assert.equal(
    (
      await getPullRequest("octo/hello", 7, async () =>
        fail("error connecting to api.github.com"),
      )
    ).problem,
    "network",
  );
});

test("the branch row's changes run gh pr with the method and the head seen", async () => {
  const target = { repository: "octo/hello", number: 7 };
  assert.deepEqual(
    pullRequestActionArgs({
      ...target,
      action: "merge",
      headSha: "0123456789abcdef",
      mergeMethod: "merge",
    }),
    [
      "pr",
      "merge",
      "7",
      "--repo",
      "octo/hello",
      "--merge",
      "--match-head-commit",
      "0123456789abcdef",
    ],
  );
  assert.deepEqual(
    pullRequestActionArgs({ ...target, action: "autoMergeOn" }),
    ["pr", "merge", "7", "--repo", "octo/hello", "--auto", "--squash"],
  );
  assert.deepEqual(
    pullRequestActionArgs({ ...target, action: "autoMergeOff" }).slice(-1),
    ["--disable-auto"],
  );
  assert.deepEqual(pullRequestActionArgs({ ...target, action: "ready" }), [
    "pr",
    "ready",
    "7",
    "--repo",
    "octo/hello",
  ]);
  assert.deepEqual(
    pullRequestActionArgs({ ...target, action: "draft" }).slice(-1),
    ["--undo"],
  );

  const answer =
    (result: GhResult): GhRunner =>
    async () =>
      result;
  assert.deepEqual(
    await pullRequestAction({ ...target, action: "ready" }, answer(ok({}))),
    { ok: true },
  );
  assert.deepEqual(
    await pullRequestAction(
      { ...target, action: "merge" },
      answer({
        code: 0,
        stdout: "",
        stderr: "! Pull request #7 will be added to the merge queue",
      }),
    ),
    { ok: true, queued: true },
  );
  assert.deepEqual(
    await pullRequestAction(
      { ...target, action: "autoMergeOn" },
      answer(
        fail(
          "GraphQL: Pull request Auto merge is not allowed for this repository (enablePullRequestAutoMerge)",
        ),
      ),
    ),
    { ok: false, reason: "repo_disallows_auto_merge" },
  );
  assert.deepEqual(
    await pullRequestAction(
      { ...target, action: "merge" },
      answer(fail("Head branch was modified. Review and try the merge again.")),
    ),
    { ok: false, reason: "head_moved" },
  );
  assert.deepEqual(
    await pullRequestAction(
      { ...target, action: "ready" },
      answer({ code: 127, stdout: "", stderr: "", missing: true }),
    ),
    { ok: false, reason: "gh_unavailable" },
  );
  assert.deepEqual(
    await pullRequestAction(
      { ...target, action: "ready" },
      answer(fail("something odd\ngh: the server said no")),
    ),
    { ok: false, reason: "unknown", detail: "the server said no" },
  );
  // A bad repository or head never reaches gh.
  let ran = false;
  const never: GhRunner = async () => {
    ran = true;
    return ok({});
  };
  assert.equal(
    (
      await pullRequestAction(
        { repository: "nope", number: 7, action: "ready" },
        never,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await pullRequestAction(
        { ...target, action: "merge", headSha: "--admin" },
        never,
      )
    ).ok,
    false,
  );
  assert.equal(ran, false);
});
