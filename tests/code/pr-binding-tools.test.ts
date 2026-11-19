import assert from "node:assert/strict";
import test from "node:test";
import { syncBaseExtension } from "../../electron/git/sync-base-branch";
import type { GhRunner } from "../../electron/git/github-cli";
import {
  bindPrTool,
  setPrMonitorTool,
  syncBaseNamespace,
  unbindPrTool,
} from "../../shared/sync-base-branch";
import type { Conversation, SessionPullRequest } from "../../shared/types";

const url = "https://github.com/octo/hello/pull/7";
const binding: SessionPullRequest = {
  repository: "octo/hello",
  number: 7,
  url,
  state: "open",
  checkedAt: 1,
  autoFix: { ci: true, comments: true, delivered: ["check/9"] },
};

function harness() {
  const c: Conversation = {
    id: "session",
    mode: "code",
    cwd: "/checkout",
    turns: [],
    title: "Test session",
    providerId: "local",
    model: "model",
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  };
  const sessions = [c];
  const approvals: string[] = [];
  const reads: string[][] = [];
  let changes = 0;
  let approve = () => true;
  let origin = "git@github.com:Octo/Hello.git";
  const pr = {
    number: 7,
    url,
    state: "OPEN",
    isDraft: true,
    headRefName: "feature",
  };
  const run: GhRunner = async (args) => {
    reads.push(args);
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({ data: { repository: { pullRequest: pr } } }),
    };
  };
  const extension = syncBaseExtension(
    async () => origin,
    {
      conversations: () => sessions,
      ask: async (id, params) => {
        assert.equal(id, c.id);
        approvals.push(String(params.message));
        return { action: approve() ? "accept" : "decline" };
      },
    },
    run,
  );
  const call = (tool: string, args: Record<string, unknown> = { url }) =>
    extension.handleDynamicTool?.({
      conversation: c,
      threadId: "thread",
      turnId: "turn",
      callId: "call",
      namespace: syncBaseNamespace,
      tool,
      arguments: args,
      changed: () => changes++,
    });
  return {
    c,
    sessions,
    pr,
    reads,
    approvals,
    call,
    approve: (next: () => boolean) => {
      approve = next;
    },
    setOrigin: (next: string) => {
      origin = next;
    },
    changes: () => changes,
  };
}

test("bind_pr verifies and binds an open draft on the checkout origin after approval", async () => {
  const app = harness();
  app.approve(() => false);
  assert.equal((await app.call(bindPrTool))?.success, false);
  assert.equal(app.c.pullRequests?.length ?? 0, 0);
  app.approve(() => true);
  assert.equal((await app.call(bindPrTool))?.success, true);
  assert.deepEqual(
    app.c.pullRequests?.map((row) => [row.url, row.state, row.headRef]),
    [[url, "draft", "feature"]],
  );
  assert.ok(
    app.reads.every(
      (args) =>
        args.includes("number=7") &&
        args.includes("--hostname") &&
        args.includes("github.com"),
    ),
  );
  assert.equal((await app.call(bindPrTool))?.success, true);
  assert.equal(app.approvals.length, 2);
  assert.equal(app.changes(), 1);
});

test("bind_pr accepts a repository already held by a session and refuses a closed or mismatched PR", async () => {
  const app = harness();
  app.setOrigin("git@github.com:octo/other.git");
  assert.equal((await app.call(bindPrTool))?.success, false);
  assert.equal(app.reads.length, 0);
  app.sessions.push({ ...app.c, id: "other", pullRequests: [binding] });
  app.pr.state = "CLOSED";
  assert.equal((await app.call(bindPrTool))?.success, false);
  app.pr.state = "OPEN";
  app.pr.url = "https://github.com/octo/other/pull/7";
  assert.equal((await app.call(bindPrTool))?.success, false);
  assert.equal(app.approvals.length, 0);
  app.pr.url = url;
  assert.equal((await app.call(bindPrTool))?.success, true);
});

test("unbind_pr retains the row and bind_pr restores it with Auto-fix off after approval", async () => {
  const app = harness();
  app.c.pullRequests = [binding];
  assert.equal((await app.call(unbindPrTool))?.success, true);
  assert.deepEqual(app.c.pullRequests, [{ ...binding, dismissed: true }]);
  app.approve(() => false);
  assert.equal((await app.call(bindPrTool))?.success, false);
  assert.equal(app.c.pullRequests[0].dismissed, true);
  app.approve(() => true);
  assert.equal((await app.call(bindPrTool))?.success, true);
  assert.equal(app.c.pullRequests.length, 1);
  assert.equal(app.c.pullRequests[0].dismissed, false);
  assert.deepEqual(app.c.pullRequests[0].autoFix, {
    ci: false,
    comments: false,
    delivered: ["check/9"],
  });
});

test("set_pr_monitor changes the named canonical row and rejects a stale approval", async () => {
  const app = harness();
  const other = {
    ...binding,
    number: 8,
    url: "https://github.com/octo/hello/pull/8",
  };
  app.c.pullRequests = [binding, other];
  assert.equal(
    (await app.call(setPrMonitorTool, { url, auto_fix: false }))?.success,
    true,
  );
  assert.deepEqual(app.c.pullRequests, [
    {
      ...binding,
      autoFix: { ci: false, comments: false, delivered: ["check/9"] },
    },
    other,
  ]);
  assert.equal(app.c.prAutoFix, undefined);
  app.approve(() => {
    app.c.pullRequests = [{ ...binding, dismissed: true }, other];
    return true;
  });
  assert.equal(
    (await app.call(setPrMonitorTool, { url, auto_fix: false }))?.success,
    false,
  );
  assert.equal(app.c.pullRequests[0].dismissed, true);
  assert.equal(app.changes(), 1);
});

test("set_pr_monitor still supports a session with only a PR announcement", async () => {
  const app = harness();
  app.c.turns = [
    {
      id: "previous-turn",
      prompt: "Open a pull request",
      attachments: [],
      createdAt: 0,
      status: "completed",
      items: [
        {
          id: "announcement",
          type: "agentMessage",
          text: `<pr-created>${url}</pr-created>`,
        },
      ],
    },
  ];
  assert.equal(
    (await app.call(setPrMonitorTool, { auto_fix: true, auto_archive: true }))
      ?.success,
    true,
  );
  assert.deepEqual(app.c.prAutoFix, { ci: true, comments: true });
  assert.equal(app.c.prAutoArchive, true);
});
