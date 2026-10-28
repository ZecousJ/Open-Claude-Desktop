import assert from "node:assert/strict";
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
} from "../../runner/src/github-tools";
import { repositorySpaceId } from "../../runner/src/github-workspace";

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
