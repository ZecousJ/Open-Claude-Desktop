import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  autoFixFacts,
  startPullRequestAutoFix,
} from "../../electron/git/pr-autofix";
import type { AppContext } from "../../electron/app/app-context";
import type { Conversation } from "../../shared/types";
const result = (head = "one") =>
  autoFixFacts({
    state: "OPEN",
    headRefOid: head,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: { nodes: [{ name: "test", conclusion: "FAILURE" }] },
            },
          },
        },
      ],
    },
    reviewThreads: { nodes: [] },
  })!;
const session = (): Conversation => ({
  id: "cloud-pr",
  mode: "code",
  environment: { kind: "space", spaceId: "one" },
  title: "Synthetic PR",
  pinned: false,
  archived: false,
  providerId: "fixture",
  model: "Opus",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  turns: [
    {
      id: "one",
      prompt: "Synthetic",
      createdAt: Date.now(),
      status: "completed",
      attachments: [],
      items: [
        {
          id: "pr",
          type: "agentMessage",
          text: "<pr-created>https://github.com/octo/repo/pull/3</pr-created>",
        },
      ],
    },
  ],
  prAutoFix: { ci: true, comments: true },
});
type Input = Parameters<AppContext["engine"]["send"]>[0];
function clock(t: TestContext) {
  let tick: () => Promise<void> = async () => {};
  t.mock.method(
    globalThis,
    "setInterval",
    (callback: () => Promise<void>, milliseconds: number) => {
      assert.equal(milliseconds, 60_000);
      tick = callback;
      return { unref() {} };
    },
  );
  t.mock.method(globalThis, "clearInterval", () => {});
  t.mock.method(console, "warn", () => {});
  return () => tick();
}
function context(
  c: Conversation,
  read: () => Promise<ReturnType<typeof result>>,
  send: (input: Input) => Promise<unknown>,
) {
  const data = {
    settings: { prAutoFix: false },
    conversations: [c],
    flushes: 0,
    flush() {
      this.flushes++;
    },
  };
  const ctx = {
    store: data,
    engine: { send },
    services: { readPullRequestAutoFix: read },
    push() {},
  } as unknown as AppContext;
  const stop = startPullRequestAutoFix(ctx, async () => {
    throw Error("Hosted watcher must not use local gh");
  });
  return { ctx, data, stop };
}
test("cloud watcher retries an unaccepted wake, remembers only success, and treats a new head as new work", async (t) => {
  const tick = clock(t),
    c = session(),
    sends: Input[] = [];
  let head = "one",
    reject = true;
  const h = context(
    c,
    async () => result(head),
    async (input) => {
      sends.push(input);
      if (reject) throw Error("synthetic offline");
      return c;
    },
  );
  t.after(h.stop);
  await tick();
  assert.equal(sends.length, 1);
  assert.equal(c.prAutoFix!.delivered, undefined);
  reject = false;
  await tick();
  assert.equal(sends.length, 2);
  assert.deepEqual(c.prAutoFix!.delivered, ["f:one:test"]);
  assert.match(sends[1].text, /the Claudex cloud service/);
  assert.match(sends[1].notificationKey!, /^[a-f0-9]{64}$/);
  assert.equal(sends[0].notificationKey, sends[1].notificationKey);
  assert.equal(sends[1].model, "Opus");
  await tick();
  assert.equal(sends.length, 2);
  head = "two";
  await tick();
  assert.equal(sends.length, 3);
  assert.notEqual(sends[1].notificationKey, sends[2].notificationKey);
});
test("recorded CI receipt recovers a lost acknowledgement without duplicate model delivery", async (t) => {
  const tick = clock(t),
    c = session();
  let sends = 0;
  const h = context(
    c,
    async () => result(),
    async (input) => {
      sends++;
      c.turns.push({
        id: "receipt",
        prompt: input.text,
        attachments: [],
        items: [],
        status: "completed",
        createdAt: Date.now(),
        notificationTrigger: input.notificationTrigger,
        notificationKey: input.notificationKey,
      });
      throw Error("lost acknowledgement");
    },
  );
  t.after(h.stop);
  await tick();
  assert.equal(sends, 1);
  assert.deepEqual(c.prAutoFix!.delivered, ["f:one:test"]);
  // The receipt is also useful when an earlier process died before persisting its delivered set.
  c.prAutoFix!.delivered = [];
  await tick();
  assert.equal(sends, 1);
  assert.deepEqual(c.prAutoFix!.delivered, ["f:one:test"]);
});
test("a failed unaccepted turn is not a delivery receipt", async (t) => {
  const tick = clock(t),
    c = session();
  let sends = 0;
  const h = context(
    c,
    async () => result(),
    async (input) => {
      sends++;
      c.turns.push({
        id: "failed",
        prompt: input.text,
        attachments: [],
        items: [],
        status: "failed",
        sendFailed: true,
        createdAt: Date.now(),
        notificationTrigger: input.notificationTrigger,
        notificationKey: input.notificationKey,
      });
      throw Error("not accepted");
    },
  );
  t.after(h.stop);
  await tick();
  await tick();
  assert.equal(sends, 2);
  assert.equal(c.prAutoFix!.delivered, undefined);
});
test("pending cloud facts cannot wake an archived, removed or newly disabled session", async (t) => {
  const tick = clock(t);
  for (const change of [
    "archived",
    "removed",
    "off",
    "working",
    "changed-pr",
  ]) {
    const c = session();
    let finish!: (facts: ReturnType<typeof result>) => void,
      sends = 0;
    const h = context(
      c,
      () => new Promise((resolve) => (finish = resolve)),
      async () => {
        sends++;
        return c;
      },
    );
    const pending = tick();
    if (change === "archived") c.archived = true;
    if (change === "removed") h.data.conversations = [];
    if (change === "off") c.prAutoFix = { ci: false, comments: false };
    if (change === "working") c.turns.at(-1)!.status = "inProgress";
    if (change === "changed-pr")
      (c.turns[0].items[0] as { text: string }).text =
        "<pr-created>https://github.com/octo/repo/pull/4</pr-created>";
    finish(result());
    await pending;
    assert.equal(sends, 0, change);
    h.stop();
  }
});
test("hosted auth/read failures stay retryable and never use the local CLI", async (t) => {
  const tick = clock(t),
    c = session();
  let reject = true,
    reads = 0,
    sends = 0;
  const h = context(
    c,
    async () => {
      reads++;
      if (reject) throw Error("synthetic authentication expired");
      return result();
    },
    async () => {
      sends++;
      return c;
    },
  );
  t.after(h.stop);
  await tick();
  assert.equal(sends, 0);
  assert.equal(c.prAutoFix!.delivered, undefined);
  reject = false;
  await tick();
  assert.equal(reads, 2);
  assert.equal(sends, 1);
});
test("global defaults apply only to a fresh new PR; existing per-session choices stay authoritative", async (t) => {
  const tick = clock(t),
    c = session();
  delete c.prAutoFix;
  let reads = 0;
  const h = context(
    c,
    async () => {
      reads++;
      return result();
    },
    async () => c,
  );
  t.after(h.stop);
  await tick();
  assert.equal(reads, 0);
  h.data.settings.prAutoFix = true;
  await tick();
  assert.equal(reads, 1);
  assert.equal(c.prAutoFix!.ci, true);
  c.prAutoFix = { ci: false, comments: false };
  await tick();
  assert.equal(reads, 1);
  delete c.prAutoFix;
  c.turns.at(-1)!.createdAt = Date.now() - 7_200_000;
  await tick();
  assert.equal(reads, 1);
});

test("CI event receipts survive a real profile restart", async (t) => {
  const { Store } = await import("../../electron/store/store");
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-ci-receipt-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tick = clock(t),
    store = new Store(directory),
    c = session();
  store.conversations.push(c);
  const ctx = {
    store,
    engine: {
      send: async (input: Input) => {
        c.turns.push({
          id: "persisted-receipt",
          prompt: input.text,
          attachments: [],
          items: [],
          createdAt: Date.now(),
          status: "completed",
          notificationTrigger: input.notificationTrigger,
          notificationKey: input.notificationKey,
        });
        store.flush();
        throw Error("acknowledgement lost");
      },
    },
    services: { readPullRequestAutoFix: async () => result() },
    push() {},
  } as unknown as AppContext;
  const stop = startPullRequestAutoFix(ctx);
  await tick();
  stop();
  // Simulate losing the delivered-set write after the event receipt was saved.
  c.prAutoFix!.delivered = [];
  store.flush();
  const restarted = new Store(directory);
  let sends = 0;
  const next = {
    store: restarted,
    engine: {
      send: async () => {
        sends++;
        return c;
      },
    },
    services: { readPullRequestAutoFix: async () => result() },
    push() {},
  } as unknown as AppContext;
  const finish = startPullRequestAutoFix(next);
  try {
    await tick();
    assert.equal(sends, 0);
    assert.deepEqual(restarted.conversations[0].prAutoFix!.delivered, [
      "f:one:test",
    ]);
    assert.equal(
      restarted.conversations[0].turns.at(-1)!.notificationKey?.length,
      64,
    );
  } finally {
    finish();
  }
});
