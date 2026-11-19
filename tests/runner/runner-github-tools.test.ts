import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  autoPullRequestStep,
  gitHubTools,
  originUrl,
  ownRepository,
  validBranch,
  type GitHubToolsOptions,
} from "../../runner/src/github-tools";
import { repositorySpaceId, runGit } from "../../runner/src/github-workspace";
import {
  persistSessionPullRequest,
  recordPullRequest,
} from "../../runner/src/session-git";
import { LinkRequestError } from "../../runner/src/control-link";
import { createPrPrompt } from "../../shared/pull-request";
import type { DynamicToolResult } from "../../electron/engine/engine-extensions";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

function session(url: string, origin = url) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gh-tools-"));
  fs.mkdirSync(path.join(cwd, ".git", "objects", "pack"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/feature\n");
  fs.writeFileSync(
    path.join(cwd, ".git", "config"),
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  return { cwd, spaceId: repositorySpaceId(url) };
}

function call(cwd: string, spaceId: string, tool: string, args: object = {}) {
  return {
    conversation: {
      id: "c",
      mode: "code",
      cwd,
      environment: { kind: "space", spaceId },
      turns: [],
    } as any,
    threadId: "t",
    turnId: "u",
    callId: "k",
    namespace: "github",
    tool,
    arguments: args,
    changed() {},
  };
}

test("origin, branch names and a repository that stays in its folder", () => {
  assert.equal(
    originUrl(
      '[remote "upstream"]\n url = x\n[remote "origin"]\n url = https://github.com/a/b.git\n',
    ),
    "https://github.com/a/b.git",
  );
  assert.ok(validBranch("feature/one"));
  for (const bad of ["-x", "a..b", "a b", "a~1", "x.lock", ""])
    assert.equal(validBranch(bad), false, bad);
  const { cwd } = session("https://github.com/a/b");
  assert.doesNotThrow(() => ownRepository(cwd));
  fs.symlinkSync(
    "/etc/passwd",
    path.join(cwd, ".git", "objects", "pack", "x.pack"),
  );
  assert.throws(() => ownRepository(cwd), /links outside/);
});

test("pushing runs git in a repository of its own, never forced", async () => {
  const url = "https://github.com/a/b";
  const { cwd, spaceId } = session(url, "https://github.com/a/b.git");
  const runs: string[][] = [];
  const requests: any[] = [];
  const tools = gitHubTools({
    userId: 7,
    transport: {
      request: async (op: string, userId: number, body: unknown) => {
        requests.push({ op, userId, body });
        return {
          url: "https://github.com/a/b.git",
          username: "x-access-token",
          token: "secret-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          repository: "a/b",
          defaultBranch: "main",
          canPush: true,
        };
      },
    } as any,
    runGit: async ({ argv }) => {
      runs.push(argv);
      return { code: 0, stderr: "" };
    },
  });
  const answer = await tools.handleDynamicTool!(call(cwd, spaceId, "push"));
  assert.equal(answer?.success, true, JSON.stringify(answer));
  assert.equal(requests[0].op, "github.push");
  assert.equal(runs.length, 3);
  assert.equal(runs[0]![0], "init");
  // Every step runs in the temporary repository, not in the session's folder.
  for (const argv of runs.slice(1)) assert.equal(argv[0], "-C");
  const pushArgv = runs[2]!;
  assert.ok(pushArgv.includes("refs/heads/feature:refs/heads/feature"));
  assert.ok(!pushArgv.some((a) => a.startsWith("+") || a === "--force"));
  assert.ok(!JSON.stringify(answer).includes("secret-token"));
});

test("a session whose origin was changed is refused", async () => {
  const { cwd, spaceId } = session(
    "https://github.com/a/b",
    "https://github.com/a/other.git",
  );
  const tools = gitHubTools({
    userId: 7,
    transport: { request: async () => assert.fail("no request") } as any,
  });
  const answer = await tools.handleDynamicTool!(
    call(cwd, spaceId, "create_issue", { title: "x" }),
  );
  assert.equal(answer?.success, false);
  assert.match(
    answer!.contentItems[0]!.type === "inputText"
      ? (answer!.contentItems[0] as any).text
      : "",
    /origin/,
  );
});

test("the namespace's tools are written in Codex's canonical form", () => {
  const tools = gitHubTools({ userId: 1, transport: {} as any });
  const specs = tools.dynamicTools!({
    mode: "code",
    conversation: { environment: { kind: "space", spaceId: "r-abc" } },
  } as any)!;
  assert.equal(specs.length, 1);
  const namespace = specs[0] as any;
  assert.equal(namespace.type, "namespace");
  // Codex refuses a mix of canonical and legacy entries (thread/start fails).
  for (const tool of namespace.tools) assert.equal(tool.type, "function");
});

test("a session with several repositories acts on the one it names", async () => {
  const url = "https://github.com/a/b";
  const { cwd, spaceId } = session(url, "https://github.com/a/b.git");
  // The other repository, cloned into a folder inside the session's.
  const other = path.join(cwd, "tool");
  fs.mkdirSync(path.join(other, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(other, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(other, ".git", "HEAD"), "ref: refs/heads/fix\n");
  fs.writeFileSync(
    path.join(other, ".git", "config"),
    `[remote "origin"]\n\turl = https://github.com/acme/tool.git\n`,
  );
  const requests: any[] = [];
  const runs: string[][] = [];
  const tools = gitHubTools({
    userId: 7,
    transport: {
      request: async (op: string, _userId: number, body: any) => {
        requests.push({ op, body });
        return {
          url: body.url,
          username: "x-access-token",
          token: "secret-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          repository: "acme/tool",
          defaultBranch: "main",
          canPush: true,
        };
      },
    } as any,
    runGit: async ({ argv }) => {
      runs.push(argv);
      return { code: 0, stderr: "" };
    },
  });
  const withRepos = (tool: string, args: object) => {
    const c = call(cwd, spaceId, tool, args);
    c.conversation.sessionRepositories = [
      { url },
      { url: "https://github.com/acme/tool" },
    ];
    return c;
  };
  // The tools offer `repository` and name the others.
  const specs = tools.dynamicTools!({
    mode: "code",
    conversation: withRepos("push", {}).conversation,
  } as any)!;
  const namespace = specs[0] as any;
  assert.match(namespace.description, /acme\/tool/);
  for (const tool of namespace.tools)
    assert.ok(tool.inputSchema.properties.repository, tool.name);

  const pushed = await tools.handleDynamicTool!(
    withRepos("push", { repository: "acme/tool" }),
  );
  assert.equal(pushed?.success, true, JSON.stringify(pushed));
  assert.equal(requests[0].body.url, "https://github.com/acme/tool.git");
  // The branch is the other checkout's, fetched from its own folder.
  assert.ok(runs[1]!.some((a) => a.includes(path.join(other, ".git"))));
  assert.ok(runs[2]!.includes("refs/heads/fix:refs/heads/fix"));

  await tools.handleDynamicTool!(
    withRepos("create_issue", { title: "x", repository: "ACME/tool.git" }),
  );
  assert.equal(requests.at(-1).op, "github.api");
  assert.equal(requests.at(-1).body.url, "https://github.com/acme/tool.git");

  // The main one by name, and nothing outside the session.
  await tools.handleDynamicTool!(
    withRepos("create_issue", { title: "x", repository: "a/b" }),
  );
  assert.equal(requests.at(-1).body.url, "https://github.com/a/b.git");
  const elsewhere = await tools.handleDynamicTool!(
    withRepos("create_issue", { title: "x", repository: "evil/repo" }),
  );
  assert.equal(elsewhere?.success, false);
  assert.match((elsewhere!.contentItems[0] as any).text, /isn't one of/);

  // A checkout whose origin was pointed elsewhere is not found.
  fs.writeFileSync(
    path.join(other, ".git", "config"),
    `[remote "origin"]\n\turl = https://github.com/evil/repo.git\n`,
  );
  const moved = await tools.handleDynamicTool!(
    withRepos("create_issue", { title: "x", repository: "acme/tool" }),
  );
  assert.equal(moved?.success, false);
});

test("a push asks for the pull request the user's settings open automatically", () => {
  assert.deepEqual(autoPullRequestStep(undefined, "feature", "main"), {});
  // Never for the default branch itself.
  assert.deepEqual(autoPullRequestStep("ready", "main", "main"), {});
  assert.match(
    autoPullRequestStep("ready", "feature", "main").next!,
    /draft false, base main/,
  );
  assert.match(
    autoPullRequestStep("draft", "feature", "main").next!,
    /as a draft.*draft true/,
  );
});

const repoUrl = "https://github.com/a/b.git";
const pushGrant = {
  url: repoUrl,
  username: "x-access-token",
  token: "secret-token",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  repository: "a/b",
  defaultBranch: "release",
  canPush: true,
};
const pull = {
  number: 14,
  html_url: "https://github.com/a/b/pull/14",
  title: "Make the change",
  state: "open",
  draft: false,
  head_ref: "topic/remote",
  head_repository: "a/b",
  base_ref: "release",
  created_at: "2026-09-10T11:12:00Z",
};

function payload(answer: DynamicToolResult | undefined) {
  assert.equal(answer?.success, true, JSON.stringify(answer));
  const item = answer?.contentItems[0];
  assert.ok(item?.type === "inputText");
  return JSON.parse(item.text);
}

test("an authenticated Git push creates and links the configured draft PR", async (t) => {
  useElectronShim();
  const { CloudStore } = await import("../../runner/src/cloud-store");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-auto-pull-"));
  const transport = memoryWebstore();
  const open = (profile: string) =>
    CloudStore.open({ root: path.join(root, profile), userId: 7, transport });
  const store = await open("profile");
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "session");
  const remote = path.join(root, "remote.git");
  const git = (...argv: string[]) =>
    execFileSync("git", argv, { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "feature", cwd);
  git("init", "--bare", "-q", remote);
  git("-C", cwd, "remote", "add", "origin", repoUrl);
  git(
    "-C",
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "Feature",
  );
  const commit = git("-C", cwd, "rev-parse", "HEAD");
  const input = call(cwd, repositorySpaceId(repoUrl), "push", {
    remote_branch: pull.head_ref,
  });
  input.conversation.title = "\nMake the change\n";
  input.conversation.branch = "feature";
  Object.assign(input.conversation, {
    providerId: "test",
    model: "test",
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: false,
  });
  store.conversations.push(input.conversation);
  let existing: typeof pull | null = null;
  let writes = 0;
  let publications = 0;
  input.changed = () => {
    publications++;
  };
  const tools = gitHubTools({
    userId: 7,
    tempRoot: root,
    transport: {
      async request(op, user, body) {
        assert.equal(user, 7);
        if (op === "github.push") return pushGrant;
        assert.equal(op, "github.api");
        assert.equal(
          git("--git-dir", remote, "rev-parse", "refs/heads/topic/remote"),
          commit,
        );
        if (
          typeof body === "object" &&
          body &&
          "action" in body &&
          body.action === "pr.byHead"
        ) {
          assert.deepEqual(body, {
            url: repoUrl,
            action: "pr.byHead",
            head: "topic/remote",
            headRepository: "a/b",
            base: "release",
          });
          return { pull_request: existing };
        }
        assert.deepEqual(body, {
          url: repoUrl,
          action: "pr.create",
          head: "topic/remote",
          headRepository: "a/b",
          base: "release",
          title: "Make the change",
          body: "",
          draft: true,
        });
        writes++;
        existing = { ...pull, draft: true };
        return existing;
      },
    },
    runGit: async (run) =>
      runGit({
        ...run,
        argv: run.argv.includes("push")
          ? [
              "-c",
              "protocol.file.allow=always",
              ...run.argv.map((arg) => (arg === repoUrl ? remote : arg)),
            ]
          : run.argv,
      }),
    automaticPullRequests: {
      settings: () => ({ prAutoCreate: true }),
      async save(conversation, pr) {
        await persistSessionPullRequest(store, conversation, pr, () =>
          store.conversations.includes(conversation),
        );
      },
    },
  });
  const pushed = payload(await tools.handleDynamicTool!(input));
  assert.equal(pushed.pushed, "feature → a/b:topic/remote");
  assert.deepEqual(pushed.pull_request, {
    url: pull.html_url,
    number: 14,
    draft: true,
    created: true,
  });
  assert.equal(input.conversation.gitState.pushed.sha, commit);
  assert.deepEqual(input.conversation.pullRequests, [
    {
      repository: "a/b",
      url: pull.html_url,
      number: 14,
      title: "Make the change",
      state: "draft",
      headRef: "topic/remote",
      baseRef: "release",
      headRepository: "a/b",
      own: true,
      openedBySession: true,
      createdAt: Date.parse(pull.created_at),
      checkedAt: input.conversation.pullRequests[0].checkedAt,
    },
  ]);
  assert.equal(publications, 2);
  assert.equal(
    payload(await tools.handleDynamicTool!(input)).pull_request.created,
    false,
  );
  assert.equal(writes, 1);
  assert.equal(input.conversation.pullRequests.length, 1);
  assert.equal(input.conversation.pullRequests[0].openedBySession, true);
  const reopened = await open("reopened");
  try {
    assert.deepEqual(
      reopened.conversation(input.conversation.id).pullRequests,
      input.conversation.pullRequests,
    );
  } finally {
    await reopened.close();
  }
});

type AutomaticSettings = ReturnType<
  NonNullable<GitHubToolsOptions["automaticPullRequests"]>["settings"]
>;
const draftSetting = () => ({ prAutoCreate: true });
const readySetting = () => ({ prAutoCreate: true, prAutoCreateDraft: false });

function automaticToolCase(
  t: { after(cleanup: () => void): void },
  settings: () => AutomaticSettings,
  provider: (action: unknown, body: unknown) => unknown,
  failPush = false,
) {
  const { cwd, spaceId } = session(repoUrl);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const input = call(cwd, spaceId, "push", { remote_branch: pull.head_ref });
  input.conversation.title = "草".repeat(90);
  input.conversation.autoPullRequest = "draft";
  let pushes = 0;
  const actions: unknown[] = [];
  const tools = gitHubTools({
    userId: 7,
    transport: {
      async request(op, _user, body) {
        if (op === "github.push") return pushGrant;
        assert.ok(body && typeof body === "object" && "action" in body);
        actions.push(body.action);
        return provider(body.action, body);
      },
    },
    runGit: async ({ argv }) => {
      if (!argv.includes("push")) return { code: 0, stderr: "" };
      pushes++;
      return { code: failPush ? 1 : 0, stderr: "push refused" };
    },
    automaticPullRequests: {
      settings,
      async save(conversation, pr) {
        recordPullRequest(conversation, pr);
      },
    },
  });
  return { tools, input, actions, pushCount: () => pushes };
}

test("an existing open PR is linked without changing its draft status", async (t) => {
  const { tools, input } = automaticToolCase(t, draftSetting, (action) => {
    assert.equal(action, "pr.byHead");
    return { pull_request: pull };
  });
  const result = payload(await tools.handleDynamicTool!(input));
  assert.deepEqual(result.pull_request, {
    url: pull.html_url,
    number: 14,
    draft: false,
    created: false,
  });
  assert.equal(input.conversation.pullRequests[0].own, undefined);
  assert.equal(input.conversation.pullRequests[0].openedBySession, undefined);
});

test("a PR for another base cannot satisfy automatic creation", async (t) => {
  const { tools, input, actions } = automaticToolCase(t, draftSetting, () => ({
    pull_request: { ...pull, base_ref: "main" },
  }));
  const result = payload(await tools.handleDynamicTool!(input));
  assert.equal(result.pull_request, undefined);
  assert.equal(
    result.pull_request_error,
    "GitHub could not confirm the pull request.",
  );
  assert.equal(input.conversation.pullRequests, undefined);
  assert.deepEqual(actions, ["pr.byHead"]);
});

test("a duplicate provider response links the concurrent PR and keeps the push successful", async (t) => {
  let opened = false;
  const { tools, input, pushCount } = automaticToolCase(
    t,
    readySetting,
    (action, body) => {
      if (action === "pr.byHead") return { pull_request: opened ? pull : null };
      assert.deepEqual(body, {
        url: repoUrl,
        action: "pr.create",
        head: pull.head_ref,
        headRepository: "a/b",
        base: "release",
        title: "草".repeat(85),
        body: "",
        draft: false,
      });
      opened = true;
      throw new LinkRequestError({
        code: "CLAUDEX_GITHUB_REFUSED",
        message: "A pull request already exists.",
      });
    },
  );
  const result = payload(await tools.handleDynamicTool!(input));
  assert.equal(result.pull_request.created, false);
  assert.equal(result.pull_request_error, undefined);
  assert.equal(input.conversation.pullRequests[0].url, pull.html_url);
  assert.equal(pushCount(), 1);
});

test("a refused PR is reported separately from its successful push", async (t) => {
  const { tools, input, pushCount } = automaticToolCase(
    t,
    readySetting,
    (action) => {
      if (action === "pr.byHead") return { pull_request: null };
      throw new LinkRequestError({
        code: "CLAUDEX_GITHUB_REFUSED",
        message: "No commits between release and topic/remote.",
      });
    },
  );
  const result = payload(await tools.handleDynamicTool!(input));
  assert.match(result.pushed, /a\/b:topic\/remote$/);
  assert.equal(
    result.pull_request_error,
    "No commits between release and topic/remote.",
  );
  assert.equal(input.conversation.pullRequests, undefined);
  assert.equal(pushCount(), 1);
});

test("automatic PR creation requires a successful push and active approval", async (t) => {
  await t.test("off overrides the old continuation", async (t) => {
    const { tools, input, actions } = automaticToolCase(
      t,
      () => ({ prAutoCreate: false }),
      () => assert.fail("unexpected GitHub API call"),
    );
    const result = payload(await tools.handleDynamicTool!(input));
    assert.equal(result.next, undefined);
    assert.equal(result.pull_request, undefined);
    assert.deepEqual(actions, []);
  });
  await t.test("an unset setting preserves the old continuation", async (t) => {
    const { tools, input, actions } = automaticToolCase(
      t,
      () => ({}),
      () => assert.fail("unexpected GitHub API call"),
    );
    const result = payload(await tools.handleDynamicTool!(input));
    assert.match(result.next, /draft true, base release/);
    assert.deepEqual(actions, []);
  });
  await t.test("a failed push never starts GitHub PR requests", async (t) => {
    const { tools, input, actions } = automaticToolCase(
      t,
      draftSetting,
      () => assert.fail("unexpected GitHub API call"),
      true,
    );
    assert.equal((await tools.handleDynamicTool!(input))?.success, false);
    assert.deepEqual(actions, []);
  });
  await t.test("the default branch is skipped", async (t) => {
    const { tools, input, actions } = automaticToolCase(t, draftSetting, () =>
      assert.fail("unexpected GitHub API call"),
    );
    const result = payload(
      await tools.handleDynamicTool!({
        ...input,
        arguments: { remote_branch: "release" },
      }),
    );
    assert.equal(result.branch, "release");
    assert.equal(result.pull_request, undefined);
    assert.deepEqual(actions, []);
  });
  await t.test(
    "the explicit command keeps its chosen draft status",
    async (t) => {
      const { tools, input, actions } = automaticToolCase(t, draftSetting, () =>
        assert.fail("unexpected GitHub API call"),
      );
      const result = payload(
        await tools.handleDynamicTool!({
          ...input,
          turn: {
            id: "u",
            prompt: createPrPrompt({
              branch: "feature",
              draft: false,
              cloud: true,
            }),
            status: "inProgress",
            attachments: [],
            items: [],
            createdAt: 0,
          },
        }),
      );
      assert.equal(result.pull_request, undefined);
      assert.deepEqual(actions, []);
    },
  );
  await t.test(
    "disabling the setting during the lookup stops creation",
    async (t) => {
      let settings: AutomaticSettings = draftSetting();
      const { tools, input, actions } = automaticToolCase(
        t,
        () => settings,
        (action) => {
          assert.equal(action, "pr.byHead");
          settings = { prAutoCreate: false };
          return { pull_request: null };
        },
      );
      assert.equal(
        payload(await tools.handleDynamicTool!(input)).pull_request,
        undefined,
      );
      assert.deepEqual(actions, ["pr.byHead"]);
    },
  );
});
