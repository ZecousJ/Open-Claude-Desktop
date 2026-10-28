import assert from "node:assert/strict";
import test from "node:test";
import {
  autoFixFacts,
  startPullRequestAutoFix,
} from "../../electron/git/pr-autofix";
import type { Conversation } from "../../shared/types";
import type { AppContext } from "../../electron/app/app-context";
import {
  autoFixMessage,
  autoFixNews,
  cleanGitHubText,
  rememberDelivered,
} from "../../shared/pr-autofix";

const pull = {
  state: "OPEN",
  headRefOid: "abc123",
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                { __typename: "CheckRun", name: "test", conclusion: "FAILURE" },
                { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS" },
                {
                  __typename: "StatusContext",
                  context: "ci/build",
                  state: "ERROR",
                },
              ],
            },
          },
        },
      },
    ],
  },
  reviewThreads: {
    nodes: [
      {
        isResolved: false,
        comments: {
          nodes: [
            {
              databaseId: 9,
              viewerDidAuthor: false,
              body: "Rename <this>",
              path: "a.ts",
              line: 4,
              author: { login: "rev" },
            },
            {
              databaseId: 10,
              viewerDidAuthor: true,
              body: "done",
              author: { login: "me" },
            },
          ],
        },
      },
      {
        isResolved: true,
        comments: { nodes: [{ databaseId: 11, body: "old" }] },
      },
    ],
  },
};

test("hosted auto-fix checks the account connection and stops pending wakes on sign-out", async (t) => {
  let tick: () => Promise<void> = async () => {};
  t.mock.method(globalThis, "setInterval", (callback: () => Promise<void>) => {
    tick = callback;
    return { unref() {} };
  });
  t.mock.method(globalThis, "clearInterval", () => {});
  let reads = 0;
  let sends = 0;
  let release: ((value: ReturnType<typeof autoFixFacts>) => void) | undefined;
  const conversation = {
    id: "hosted",
    mode: "code",
    environment: { kind: "space", spaceId: "space-one" },
    prAutoFix: { ci: true, comments: true },
    turns: [
      {
        status: "completed",
        items: [
          {
            type: "agentMessage",
            text: "<pr-created>https://github.com/octo/repo/pull/3</pr-created>",
          },
        ],
      },
    ],
  } as unknown as Conversation;
  const ctx = {
    store: { conversations: [conversation], flush() {} },
    services: {
      readPullRequestAutoFix: async () => {
        reads++;
        return new Promise<ReturnType<typeof autoFixFacts>>((resolve) => {
          release = resolve;
        });
      },
    },
    engine: {
      async send() {
        sends++;
      },
    },
    push() {},
  } as unknown as AppContext;
  const stop = startPullRequestAutoFix(ctx, async () => {
    throw new Error("must not use local gh");
  });
  const pending = tick();
  assert.equal(reads, 1);
  stop();
  release!(autoFixFacts(pull));
  await pending;
  assert.equal(sends, 0);
  await tick();
  assert.equal(reads, 1);
});

test("a scheduled task's Auto-fix pull requests turns auto-fix on for its runs' new pull requests", async (t) => {
  let tick: () => Promise<void> = async () => {};
  t.mock.method(globalThis, "setInterval", (callback: () => Promise<void>) => {
    tick = callback;
    return { unref() {} };
  });
  t.mock.method(globalThis, "clearInterval", () => {});
  const session = (id: string, scheduledTaskId: string) =>
    ({
      id,
      mode: "code",
      scheduledTaskId,
      environment: { kind: "space", spaceId: "space-one" },
      turns: [
        {
          status: "completed",
          createdAt: Date.now(),
          items: [
            {
              type: "agentMessage",
              text: "<pr-created>https://github.com/octo/repo/pull/3</pr-created>",
            },
          ],
        },
      ],
    }) as unknown as Conversation;
  const fixing = session("fixing", "task-on");
  const plain = session("plain", "task-off");
  const ctx = {
    store: { conversations: [fixing, plain], settings: {}, flush() {} },
    scheduler: {
      list: () => [
        { id: "task-on", autoFixPullRequests: true },
        { id: "task-off" },
      ],
    },
    services: { readPullRequestAutoFix: async () => undefined },
    engine: { async send() {} },
    push() {},
  } as unknown as AppContext;
  const stop = startPullRequestAutoFix(ctx);
  await tick();
  stop();
  assert.deepEqual(fixing.prAutoFix, { ci: true, comments: true });
  assert.equal(plain.prAutoFix, undefined);
});

test("auto-fix reads failing checks and others' comments in open threads", () => {
  const facts = autoFixFacts(pull)!;
  assert.deepEqual(facts.failingChecks, ["test", "ci/build"]);
  assert.deepEqual(
    facts.comments.map((c) => c.id),
    [9],
  );
  assert.equal(autoFixFacts({ ...pull, state: "MERGED" }), undefined);
});

test("each failure and comment is reported once", () => {
  const facts = autoFixFacts(pull)!;
  const autoFix = { ci: true, comments: true };
  const first = autoFixNews(autoFix, facts);
  assert.equal(first.failing.length, 2);
  assert.equal(first.comments.length, 1);
  const after = {
    ...autoFix,
    delivered: rememberDelivered(autoFix, first.keys),
  };
  const second = autoFixNews(after, facts);
  assert.equal(second.failing.length + second.comments.length, 0);
  // A new head commit fails again: reported again.
  assert.equal(
    autoFixNews(after, { ...facts, headSha: "def" }).failing.length,
    2,
  );
  // Comments only with Auto-fix CI on.
  assert.equal(
    autoFixNews({ ci: false, comments: true }, facts).comments.length,
    0,
  );
});

test("the wake message quotes GitHub's text as data", () => {
  const facts = autoFixFacts(pull)!;
  const message = autoFixMessage({
    repository: "a/b",
    number: 3,
    failingChecks: facts.failingChecks,
    comments: facts.comments,
  })!;
  assert.match(
    message,
    /^<ci-monitor-event>"Auto-fix pull requests" \(the desktop app\) is watching a\/b PR #3/,
  );
  assert.match(message, /2 CI checks failed/);
  assert.match(message, /> "test"/);
  assert.match(message, /Comment 1 — comment_id=9, inline thread/);
  assert.match(message, /> rev on a\.ts:4:/);
  assert.match(message, /> Rename &lt;this>/);
  assert.match(
    message,
    /\(End of quoted GitHub text\.\)\n<\/ci-monitor-event>$/,
  );
  assert.equal(
    autoFixMessage({
      repository: "a/b",
      number: 3,
      failingChecks: [],
      comments: [],
    }),
    undefined,
  );
  assert.equal(cleanGitHubText("a\r\nb​c"), "a\nbc");
});
