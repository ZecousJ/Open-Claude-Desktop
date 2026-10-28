import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkingTreeHost } from "../../electron/git/working-tree";
import { gitHubTools } from "../../runner/src/github-tools";
import { repositorySpaceId } from "../../runner/src/github-workspace";
import {
  adoptTaggedPullRequests,
  applyGitFacts,
  branchCommit,
  pullRequestFromApi,
  readGitFacts,
  recordPullRequest,
  recordPush,
  refreshPullRequests,
} from "../../runner/src/session-git";
import {
  isReviewReady,
  repositoryFullName,
  sessionMatchesSearch,
  sessionRepositoryOf,
} from "../../shared/session-git";
import type { Conversation, Turn } from "../../shared/types";

/** A sandboxed `git` that answers by the first words of the query. */
function fakeHost(answers: Record<string, string | null>): WorkingTreeHost {
  return {
    async git(_cwd, args) {
      const key = args.join(" ");
      for (const [prefix, answer] of Object.entries(answers))
        if (key.startsWith(prefix)) {
          if (answer === null) throw new Error("git failed");
          return answer;
        }
      throw new Error("git failed: " + key);
    },
    async entries() {
      return new Map();
    },
    async lineCounts() {
      return {};
    },
  };
}

const head = "a".repeat(40);
const remoteConfig = "remote.origin.url https://github.com/octo/repo.git\n";

test("a repository address reads as owner/name", () => {
  assert.equal(
    repositoryFullName("https://github.com/Octo/Repo.git"),
    "Octo/Repo",
  );
  assert.equal(repositoryFullName("https://git.example.com/a/b/c/"), "b/c");
  assert.equal(repositoryFullName("https://github.com/solo"), undefined);
  assert.equal(repositoryFullName("git@github.com:a/b.git"), undefined);
  assert.deepEqual(sessionRepositoryOf({ url: "https://github.com/a/b" }), {
    fullName: "a/b",
    url: "https://github.com/a/b",
  });
});

test("the folder's branch, changes and unpushed commits are read", async () => {
  const base = {
    "rev-parse --show-toplevel": "/w/repo\n",
    "symbolic-ref --short -q HEAD": "feature\n",
    "rev-parse --verify -q HEAD": head + "\n",
    "config --get-regexp": remoteConfig,
  };
  // Never pushed, two commits ahead of main, a dirty tree.
  let facts = await readGitFacts(
    "/w/repo",
    fakeHost({
      ...base,
      "status --porcelain": " M a.txt\n",
      "rev-parse --verify -q refs/remotes/origin/feature": "",
      "symbolic-ref --short -q refs/remotes/origin/HEAD": "origin/main\n",
      "rev-list --count origin/main..HEAD": "2\n",
    }),
  );
  assert.deepEqual(facts, {
    branch: "feature",
    head,
    dirty: true,
    unpushed: true,
  });
  // Pushed: the branch's remote copy has everything.
  facts = await readGitFacts(
    "/w/repo",
    fakeHost({
      ...base,
      "status --porcelain": "",
      "rev-parse --verify -q refs/remotes/origin/feature": "b".repeat(40),
      "rev-list --count refs/remotes/origin/feature..HEAD": "0\n",
    }),
  );
  assert.equal(facts?.unpushed, false);
  assert.equal(facts?.dirty, false);
  // The runner pushed it from outside the folder: the push tool's record.
  facts = await readGitFacts(
    "/w/repo",
    fakeHost({
      ...base,
      "status --porcelain": "",
      "symbolic-ref --short -q refs/remotes/origin/HEAD": "origin/main\n",
      "rev-list --count origin/main..HEAD": "3\n",
    }),
    { branch: "feature", sha: head },
  );
  assert.equal(facts?.unpushed, false);
  // Nothing beyond the default branch: nothing to push.
  facts = await readGitFacts(
    "/w/repo",
    fakeHost({
      ...base,
      "status --porcelain": "",
      "symbolic-ref --short -q refs/remotes/origin/HEAD": "origin/main\n",
      "rev-list --count origin/main..HEAD": "0\n",
    }),
  );
  assert.equal(facts?.unpushed, false);
  // Not a repository.
  assert.equal(
    await readGitFacts("/w", fakeHost({ "rev-parse --show-toplevel": null })),
    undefined,
  );
});

function code(extra: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    title: "Fix login",
    mode: "code",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [{ id: "t", status: "completed", items: [] } as unknown as Turn],
    ...extra,
  } as Conversation;
}

test("git facts land on the conversation and report a change", () => {
  const c = code();
  assert.equal(
    applyGitFacts(c, { branch: "feature", dirty: true, unpushed: false }, 5),
    true,
  );
  assert.equal(c.branch, "feature");
  assert.deepEqual(c.gitState, { dirty: true, unpushed: false, checkedAt: 5 });
  assert.equal(
    applyGitFacts(c, { branch: "feature", dirty: true, unpushed: false }, 9),
    false,
  );
  assert.equal(c.gitState?.checkedAt, 9);
  // A detached HEAD has no branch.
  applyGitFacts(c, { dirty: false, unpushed: false });
  assert.equal(c.branch, undefined);
});

test("a push is remembered for the branch it sent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-"));
  fs.mkdirSync(path.join(dir, "refs", "heads", "feat"), { recursive: true });
  fs.writeFileSync(path.join(dir, "refs", "heads", "feat", "one"), head + "\n");
  fs.writeFileSync(
    path.join(dir, "packed-refs"),
    `# pack-refs\n${"c".repeat(40)} refs/heads/packed\n`,
  );
  assert.equal(branchCommit(dir, "feat/one"), head);
  assert.equal(branchCommit(dir, "packed"), "c".repeat(40));
  assert.equal(branchCommit(dir, "nope"), undefined);
  assert.equal(branchCommit(dir, "../../etc"), undefined);

  const c = code({ branch: "feature" });
  applyGitFacts(c, { branch: "feature", dirty: true, unpushed: true });
  recordPush(c, "feature", head, 7);
  assert.deepEqual(c.gitState?.pushed, { branch: "feature", sha: head });
  assert.equal(c.gitState?.unpushed, false);
  assert.equal(c.gitState?.dirty, true);
  // The push survives the next read of the folder.
  applyGitFacts(c, { branch: "feature", dirty: false, unpushed: false });
  assert.deepEqual(c.gitState?.pushed, { branch: "feature", sha: head });
  // Another branch's push does not clear this branch.
  const other = code({ branch: "main" });
  applyGitFacts(other, { branch: "main", dirty: false, unpushed: true });
  recordPush(other, "feature", head);
  assert.equal(other.gitState?.unpushed, true);
});

test("pull requests are recorded once and read from GitHub's answer", () => {
  const pr = pullRequestFromApi(
    {
      number: 12,
      html_url: "https://github.com/octo/repo/pull/12",
      title: "Fix login",
      state: "open",
      draft: true,
    },
    { headRef: "feature" },
  );
  assert.deepEqual(pr, {
    repository: "octo/repo",
    number: 12,
    url: "https://github.com/octo/repo/pull/12",
    title: "Fix login",
    headRef: "feature",
    state: "draft",
  });
  assert.equal(
    pullRequestFromApi({ number: 1, html_url: "https://x/y", state: "x" }),
    undefined,
  );
  assert.equal(
    pullRequestFromApi({
      number: 3,
      html_url: "https://github.com/a/b/pull/3",
      state: "closed",
      merged: true,
    })?.state,
    "merged",
  );
  const c = code();
  recordPullRequest(c, pr!, 1);
  recordPullRequest(c, { ...pr!, state: "merged" }, 2);
  assert.equal(c.pullRequests?.length, 1);
  assert.equal(c.pullRequests?.[0]?.state, "merged");
  assert.equal(c.pullRequests?.[0]?.checkedAt, 2);
});

test("open pull requests are asked about again, merged ones are left alone", async () => {
  const asked: any[] = [];
  const transport = {
    request: async (_op: string, _user: number, body: any) => {
      asked.push(body);
      return {
        number: body.number,
        html_url: `https://github.com/octo/repo/pull/${body.number}`,
        state: "closed",
        merged: true,
      };
    },
  };
  const c = code();
  recordPullRequest(c, {
    repository: "octo/repo",
    number: 1,
    url: "https://github.com/octo/repo/pull/1",
    state: "open",
  });
  recordPullRequest(c, {
    repository: "octo/repo",
    number: 2,
    url: "https://github.com/octo/repo/pull/2",
    state: "merged",
  });
  assert.equal(await refreshPullRequests(c, transport, 7, 50), true);
  assert.deepEqual(
    asked.map((a) => [a.url, a.action, a.number]),
    [["https://github.com/octo/repo", "pr.get", 1]],
  );
  assert.equal(c.pullRequests?.[0]?.state, "merged");
  // GitHub unreachable: the last state stands.
  const down = code({
    pullRequests: [
      {
        repository: "octo/repo",
        number: 4,
        url: "https://github.com/octo/repo/pull/4",
        state: "open",
        checkedAt: 1,
      },
    ],
  });
  assert.equal(
    await refreshPullRequests(
      down,
      {
        request: async () => {
          throw new Error("down");
        },
      },
      7,
    ),
    false,
  );
  assert.equal(down.pullRequests?.[0]?.state, "open");
});

test("a pull request the model named in its reply is adopted when it is the session's own", async () => {
  const transport = {
    request: async (_op: string, _user: number, body: any) => ({
      number: body.number,
      html_url: `https://github.com/octo/repo/pull/${body.number}`,
      state: "open",
    }),
  };
  const c = code({
    repository: { fullName: "octo/repo", url: "https://github.com/octo/repo" },
  });
  const turn = {
    id: "t",
    status: "completed",
    items: [
      {
        id: "m",
        type: "agentMessage",
        text: "Done. <pr-created>https://github.com/octo/repo/pull/9</pr-created> and <pr-created>https://github.com/other/repo/pull/4</pr-created>",
      },
    ],
  } as unknown as Turn;
  assert.equal(await adoptTaggedPullRequests(c, turn, transport, 7), true);
  assert.deepEqual(
    c.pullRequests?.map((p) => `${p.repository}#${p.number}`),
    ["octo/repo#9"],
  );
  // Known already: nothing to add.
  assert.equal(await adoptTaggedPullRequests(c, turn, transport, 7), false);
});

function session(url: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sg-tools-"));
  fs.mkdirSync(path.join(cwd, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/feature\n");
  fs.writeFileSync(path.join(cwd, ".git", "refs", "heads", "feature"), head);
  fs.writeFileSync(
    path.join(cwd, ".git", "config"),
    `[remote "origin"]\n\turl = ${url}.git\n`,
  );
  return { cwd, spaceId: repositorySpaceId(url) };
}

test("create_pull_request and push put the session's data on the conversation", async () => {
  const url = "https://github.com/octo/repo";
  const { cwd, spaceId } = session(url);
  let changes = 0;
  const conversation = code({
    cwd,
    environment: { kind: "space", spaceId },
  });
  const tools = gitHubTools({
    userId: 7,
    transport: {
      request: async (op: string) =>
        op === "github.push"
          ? {
              url: `${url}.git`,
              username: "x-access-token",
              token: "tok",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              repository: "octo/repo",
              defaultBranch: "main",
              canPush: true,
            }
          : {
              number: 5,
              html_url: `${url}/pull/5`,
              title: "Fix login",
              state: "open",
              draft: false,
            },
    } as any,
    runGit: async () => ({ code: 0, stderr: "" }),
  });
  const call = (tool: string, args: object) => ({
    conversation,
    threadId: "t",
    turnId: "u",
    callId: "k",
    namespace: "github",
    tool,
    arguments: args,
    changed: () => {
      changes++;
    },
  });
  applyGitFacts(conversation, {
    branch: "feature",
    dirty: false,
    unpushed: true,
  });
  const pushed = await tools.handleDynamicTool!(call("push", {}));
  assert.equal(pushed?.success, true);
  assert.match((pushed!.contentItems[0] as any).text, /"branch": "feature"/);
  assert.deepEqual(conversation.gitState?.pushed, {
    branch: "feature",
    sha: head,
  });
  assert.equal(conversation.gitState?.unpushed, false);
  const opened = await tools.handleDynamicTool!(
    call("create_pull_request", { title: "Fix login", head: "feature" }),
  );
  assert.equal(opened?.success, true);
  assert.deepEqual(
    conversation.pullRequests?.map((p) => [p.repository, p.number, p.headRef]),
    [["octo/repo", 5, "feature"]],
  );
  assert.equal(changes, 2);
});

test("a finished turn records the repository, branch and state of an older session", async () => {
  const url = "https://github.com/octo/repo";
  const { cwd, spaceId } = session(url);
  const conversation = code({ cwd, environment: { kind: "space", spaceId } });
  const published: number[] = [];
  const tools = gitHubTools({
    userId: 7,
    transport: { request: async () => ({}) } as any,
    workingTree: () =>
      fakeHost({
        "rev-parse --show-toplevel": cwd + "\n",
        "symbolic-ref --short -q HEAD": "feature\n",
        "rev-parse --verify -q HEAD": head + "\n",
        "status --porcelain": " M x\n",
        "config --get-regexp": "",
      }),
  });
  tools.onTurnCompleted!(conversation, conversation.turns[0]!, () =>
    published.push(1),
  );
  for (let i = 0; i < 50 && !published.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(published.length, 1);
  assert.deepEqual(conversation.repository, {
    fullName: "octo/repo",
    url: "https://github.com/octo/repo.git",
  });
  assert.equal(conversation.branch, "feature");
  assert.equal(conversation.gitState?.dirty, true);
  // A chat, or a session without a repository, records nothing.
  const chat = code({ mode: "chat" as any, cwd });
  tools.onTurnCompleted!(chat, chat.turns[0]!, () => assert.fail("no change"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(chat.branch, undefined);
});

test("Ready for review: finished work that GitHub has not merged", () => {
  const state = (dirty: boolean, unpushed: boolean) => ({
    dirty,
    unpushed,
    checkedAt: 1,
  });
  const pr = (s: any) => ({
    repository: "a/b",
    number: 1,
    url: "https://github.com/a/b/pull/1",
    state: s,
    checkedAt: 1,
  });
  assert.equal(isReviewReady(code()), false);
  assert.equal(isReviewReady(code({ gitState: state(true, false) })), true);
  assert.equal(isReviewReady(code({ gitState: state(false, true) })), true);
  assert.equal(isReviewReady(code({ pullRequests: [pr("open")] })), true);
  assert.equal(isReviewReady(code({ pullRequests: [pr("draft")] })), true);
  assert.equal(
    isReviewReady(
      code({ pullRequests: [pr("merged")], gitState: state(false, false) }),
    ),
    false,
  );
  // Only the newest pull request counts.
  assert.equal(
    isReviewReady(code({ pullRequests: [pr("open"), pr("closed")] })),
    false,
  );
  assert.equal(
    isReviewReady(code({ archived: true, gitState: state(true, true) })),
    false,
  );
  const running = code({ gitState: state(true, true) });
  running.turns[0]!.status = "inProgress";
  assert.equal(isReviewReady(running), false);
});

test("a list search matches the title, repository and branch", () => {
  const c = code({
    repository: { fullName: "Octo/Repo", url: "https://github.com/Octo/Repo" },
    branch: "feature/login-fix",
  });
  assert.equal(sessionMatchesSearch(c, "fix login"), true);
  assert.equal(sessionMatchesSearch(c, "octo/repo"), true);
  assert.equal(sessionMatchesSearch(c, " LOGIN-FIX "), true);
  assert.equal(sessionMatchesSearch(c, "payments"), false);
  assert.equal(sessionMatchesSearch(c, "  "), true);
});
