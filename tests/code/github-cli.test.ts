/**
 * GitHub through the machine's `gh` (electron/github-cli.ts), with a fake
 * runner standing in for the CLI: the arguments it is given, and how its
 * answers and failures read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import { readDesktopArchivePullRequests } from "../../electron/conversations/auto-archive-pull-requests";
import {
  getIssue,
  getPullRequest,
  issueSearch,
  listIssues,
  problemOf,
  pullRequestAction,
  pullRequestActionArgs,
  readPullRequestChecks,
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

const checkHead = "c".repeat(40);
const checkTarget = "repos/octo/hello";
const checkCommit = `${checkTarget}/commits/${checkHead}`;
const checkPull = ok({
  state: "open",
  head: { sha: checkHead, repo: { full_name: "contrib/hello" } },
  base: { ref: "main" },
  mergeable: true,
  mergeable_state: "blocked",
  auto_merge: null,
});

test("PR checks report the current workflow attempt, check links and commit statuses", async () => {
  const job = {
    name: "Tests",
    status: "completed",
    conclusion: "failure",
    app: { slug: "github-actions" },
    details_url: "https://github.com/octo/hello/actions/runs/7",
  };
  const workflow = { workflow_id: 1, event: "pull_request", name: "CI" };
  const run = fake({
    [`${checkTarget}/pulls/3`]: checkPull,
    [`${checkCommit}/check-runs`]: ok([
      { check_runs: [{ ...job, id: 1, check_suite: { id: 8 } }] },
      {
        check_runs: [
          { ...job, id: 2, conclusion: "cancelled", check_suite: { id: 9 } },
          { ...job, id: 3, check_suite: { id: 10 } },
        ],
      },
    ]),
    [`${checkCommit}/status`]: ok([
      { statuses: [{ context: "Deployment", state: "pending" }] },
    ]),
    [`${checkTarget}/actions/runs`]: ok([
      {
        workflow_runs: [
          {
            ...workflow,
            check_suite_id: 8,
            head_repository: { full_name: "contrib/hello" },
          },
          {
            ...workflow,
            check_suite_id: 9,
            head_repository: { full_name: "contrib/hello" },
          },
          {
            ...workflow,
            check_suite_id: 10,
            head_repository: { full_name: "unrelated/hello" },
          },
        ],
      },
    ]),
  });
  const result = await readPullRequestChecks("octo/hello", 3, run.run);
  assert.partialDeepStrictEqual(result, {
    success: true,
    headSha: checkHead,
    prState: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    autoMergeEnabled: false,
    checks: [
      {
        name: "Tests",
        state: "CANCELLED",
        bucket: "cancel",
        url: job.details_url,
        checkRunId: 2,
        workflowName: "CI",
        appSlug: "github-actions",
      },
      { name: "Deployment", state: "PENDING", bucket: "pending" },
    ],
  });
  assert.equal(result.success && result.checks.length, 2);
});

test("PR checks distinguish a confirmed empty list from an unreadable one", async () => {
  const responses = {
    [`${checkTarget}/pulls/3`]: checkPull,
    [`${checkCommit}/check-runs`]: ok([{ check_runs: [] }]),
    [`${checkCommit}/status`]: ok([{ statuses: [] }]),
  };
  const empty = await readPullRequestChecks(
    "octo/hello",
    3,
    fake(responses).run,
  );
  assert.partialDeepStrictEqual(empty, { success: true, checks: [] });
  const refused = await readPullRequestChecks(
    "octo/hello",
    3,
    fake({
      ...responses,
      [`${checkCommit}/status`]: fail("gh: Forbidden (HTTP 403)"),
    }).run,
  );
  assert.deepEqual(refused, {
    success: false,
    error: "gh: Forbidden (HTTP 403)",
    transient: false,
  });
  const invalid = await readPullRequestChecks(
    "octo/hello",
    3,
    fake({
      ...responses,
      [`${checkCommit}/status`]: ok({ status: [] }),
    }).run,
  );
  assert.deepEqual(invalid, {
    success: false,
    error: "Could not parse PR checks.",
  });
});

test("PR checks tell the renderer when gh needs installation or sign-in", async () => {
  const missing = await readPullRequestChecks("octo/hello", 3, async () => ({
    code: 127,
    stdout: "",
    stderr: "",
    missing: true,
  }));
  assert.partialDeepStrictEqual(missing, {
    success: false,
    error: "gh CLI not found in PATH",
  });
  const signedOut = await readPullRequestChecks("octo/hello", 3, async () =>
    fail("gh: Bad credentials (HTTP 401)"),
  );
  assert.partialDeepStrictEqual(signedOut, {
    success: false,
    error: "gh is not authenticated. Run gh auth login.",
  });
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

test("Code binds an assistant's tag when authenticated GitHub confirms its repository and branch", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-pr-binding-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "--initial-branch=feature", cwd], { stdio: "ignore" });
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://github.com/octo/hello.git"]);
  const url = (number: number) => `https://github.com/octo/hello/pull/${number}`;
  const tag = (url: string) => `<pr-created>${url}</pr-created>`;
  const conversation: Conversation = {
    id: "pr-binding", title: "Review", mode: "code", cwd, providerId: "p", model: "m",
    createdAt: 1, updatedAt: 2, archived: false, pinned: false,
    turns: [{
      id: "turn", prompt: tag(url(3)), status: "completed", createdAt: 2, attachments: [],
      items: [{ id: "reply", type: "agentMessage", text: [
        url(2), tag(url(4)), tag(url(5)), tag(url(6)), tag(url(7)),
        tag("https://github.com/other/repo/pull/9"),
      ].join("\n") }],
    }],
  };
  const calls: number[] = [];
  const run: GhRunner = async args => {
    const number = Number(args.at(-1)?.split("=")[1]);
    calls.push(number);
    if (number === 4) return fail("gh: Could not resolve to a PullRequest");
    return ok({ data: { repository: graphRepo({
      number, url: url(number), viewerDidAuthor: true, createdAt: "2026-11-15T10:00:00Z",
      headRepository: { nameWithOwner: number === 6 ? "someone/hello" : "octo/hello" },
      headRefName: number === 5 ? "different-branch" : "feature",
    }) } });
  };
  const bindings = await readDesktopArchivePullRequests(conversation, undefined, run);
  assert.deepEqual(calls.sort(), [4, 5, 6, 7]);
  assert.partialDeepStrictEqual(bindings, [{
    number: 7, repository: "octo/hello", headRepository: "octo/hello", url: url(7),
    headRef: "feature", baseRef: "main", own: true, createdAt: Date.parse("2026-11-15T10:00:00Z"),
  }]);
  assert.equal(bindings?.length, 1);
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
