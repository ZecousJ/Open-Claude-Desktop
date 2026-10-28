import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { pendingPolicy } from "../../shared/client-policy";
import {
  handOffPrompt,
  maxHandOffNoteLength,
  transcriptDigest,
} from "../../shared/hand-off";
import { isContextLimitError } from "../../shared/turn-errors";
import type { Conversation, Turn } from "../../shared/types";

type Call = { method: string; params: any };

const turn = (
  id: string,
  status: Turn["status"] = "completed",
  prompt = id,
): Turn => ({
  id,
  prompt,
  attachments: [],
  items: [{ id: `${id}-m`, type: "agentMessage", text: `answer ${id}` }],
  status,
  createdAt: 1,
});

function setup(
  turns: Turn[] = [turn("a"), turn("b")],
  extra: Partial<Conversation> = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-handoff-"));
  const store = new Store(root);
  store.settings.providers = [
    {
      id: "p",
      name: "Local",
      protocol: "responses",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      models: ["m"],
    },
  ];
  store.settings.activeProviderId = "p";
  const c: Conversation = {
    id: "c",
    title: "Main",
    mode: "code",
    providerId: "p",
    model: "m",
    threadId: "main",
    cwd: root,
    pinned: true,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns,
    ...extra,
  };
  store.conversations.push(c);
  const calls: Call[] = [];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => ({ ...pendingPolicy, update: undefined });
  engine.ensure = async () => {};
  let forks = 0;
  let starts = 0;
  engine.rpc = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/fork")
        return { thread: { id: `side-${++forks}` } };
      if (method === "thread/start")
        return { thread: { id: `new-${++starts}` } };
      if (method === "turn/start")
        return { turn: { id: `turn-${calls.length}` } };
      return {};
    },
    async stop() {},
  } as any;
  (engine as any).windowsSandbox = {
    assertReady() {},
    async ensureReady() {},
    reset() {},
  };
  (engine as any).syncRequestOptions = async () => {};
  const internals = engine as any;
  internals.loaded.add("main");
  internals.routes.set("main", "c");
  const notify = (threadId: string, method: string, params: object) =>
    internals.notification({ method, params: { threadId, ...params } });
  const started = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  return {
    store,
    c,
    engine,
    calls,
    notify,
    started,
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const say = (itemId: string, text: string) => ({
  item: { id: itemId, type: "agentMessage", text },
});
const finish = (status: string, error?: string) => ({
  turn: {
    id: "turn-1",
    status,
    ...(error ? { error: { message: error } } : {}),
  },
});

test("hand off writes the note on an ephemeral fork and starts a linked session from it", async () => {
  const env = setup();
  try {
    const pending = env.engine.handOffConversation("c");
    await env.started();
    const fork = env.calls.find((call) => call.method === "thread/fork")!;
    assert.equal(fork.params.threadId, "main");
    assert.equal(fork.params.lastTurnId, "b");
    assert.equal(fork.params.ephemeral, true);
    assert.equal(fork.params.sandbox, "read-only");
    assert.match(fork.params.developerInstructions, /writing a handoff note/);
    assert.doesNotMatch(fork.params.developerInstructions, /side chat/);
    const ask = env.calls.find((call) => call.method === "turn/start")!;
    assert.match(ask.params.input[0].text, /Write the handoff note/);
    // Nothing of the source was touched while the note was written.
    assert.equal(env.store.conversations.length, 1);
    env.notify("side-1", "item/completed", say("n1", "Goal: ship it."));
    env.notify("side-1", "turn/completed", finish("completed"));
    const handed = await pending;
    // The fork is released.
    assert.ok(
      env.calls.some(
        (call) =>
          call.method === "thread/unsubscribe" &&
          call.params.threadId === "side-1",
      ),
    );
    // A fresh thread, not a fork, whose first message is the note.
    assert.notEqual(handed.id, "c");
    assert.equal(handed.threadId, "new-1");
    assert.equal(handed.mode, "code");
    assert.equal(handed.title, "Main");
    assert.equal(handed.cwd, env.c.cwd);
    assert.equal(handed.model, "m");
    assert.equal(handed.pinned, false);
    assert.equal(handed.forkedFrom, undefined);
    assert.deepEqual(handed.handedOffFrom, {
      conversationId: "c",
      turnId: "b",
      title: "Main",
    });
    assert.equal(handed.turns.length, 1);
    assert.match(handed.turns[0].prompt, /Goal: ship it\./);
    assert.match(handed.turns[0].prompt, /<handoff-note>/);
    assert.match(handed.turns[0].prompt, /"Main"/);
    const first = env.calls
      .filter((call) => call.method === "turn/start")
      .at(-1)!;
    assert.equal(first.params.threadId, "new-1");
    assert.match(first.params.input[0].text, /Goal: ship it\./);
    // The source keeps its turns and thread, and records the handoff.
    assert.deepEqual(
      env.c.turns.map((t) => t.id),
      ["a", "b"],
    );
    assert.equal(env.c.threadId, "main");
    assert.deepEqual(
      env.c.handOffs?.map((record) => [record.conversationId, record.turnId]),
      [[handed.id, "b"]],
    );
    assert.equal(env.store.conversations[0].id, handed.id);
  } finally {
    env.close();
  }
});

test("Continue in cloud's note is the hand-off note, returned and nothing started", async () => {
  const env = setup();
  try {
    const pending = env.engine.writeHandOffNote("c");
    await env.started();
    const fork = env.calls.find((call) => call.method === "thread/fork")!;
    assert.equal(fork.params.ephemeral, true);
    assert.equal(fork.params.sandbox, "read-only");
    env.notify("side-1", "item/completed", say("n1", "Goal: ship it."));
    env.notify("side-1", "turn/completed", finish("completed"));
    assert.deepEqual(await pending, {
      title: "Main",
      note: "Goal: ship it.",
      written: true,
    });
    // No new session, no thread started, and the source is untouched.
    assert.equal(env.store.conversations.length, 1);
    assert.equal(
      env.calls.some((call) => call.method === "thread/start"),
      false,
    );
    assert.equal(env.c.handOffs, undefined);
  } finally {
    env.close();
  }
});

test("a session too long to answer from hands off an excerpt of its latest messages", async () => {
  const env = setup([
    turn("a", "completed", "Add a retry to the uploader"),
    turn("b", "completed", "Now the tests"),
  ]);
  try {
    const pending = env.engine.handOffConversation("c");
    await env.started();
    env.notify(
      "side-1",
      "turn/completed",
      finish(
        "failed",
        "Codex ran out of room in the model's context window. Start a new thread.",
      ),
    );
    const handed = await pending;
    const prompt = handed.turns[0].prompt;
    assert.match(prompt, /could not be written/);
    assert.match(prompt, /Person: Add a retry to the uploader/);
    assert.match(prompt, /Claudex: answer b/);
    assert.deepEqual(handed.handedOffFrom?.turnId, "b");
    assert.equal(env.c.handOffs?.length, 1);
  } finally {
    env.close();
  }
});

test("other failures of the note are reported in plain words and start nothing", async () => {
  const env = setup();
  try {
    const failed = env.engine.handOffConversation("c");
    await env.started();
    env.notify(
      "side-1",
      "turn/completed",
      finish("failed", "unexpected status 502 http://127.0.0.1:9/v1"),
    );
    await assert.rejects(failed, (error: Error) => {
      assert.match(error.message, /Couldn’t write the handoff note/);
      assert.doesNotMatch(error.message, /502|127\.0\.0\.1/);
      return true;
    });
    assert.equal(env.store.conversations.length, 1);
    assert.equal(env.c.handOffs, undefined);
    assert.equal(
      env.calls.some((call) => call.method === "thread/start"),
      false,
    );
  } finally {
    env.close();
  }
});

test("a new session that cannot start is still linked from the source", async () => {
  const env = setup();
  try {
    const rpc = (env.engine as any).rpc;
    const call = rpc.call;
    rpc.call = async (method: string, params: any) => {
      if (method === "thread/start") throw new Error("no thread");
      return call(method, params);
    };
    const pending = env.engine.handOffConversation("c");
    await env.started();
    env.notify("side-1", "item/completed", say("n1", "Note."));
    env.notify("side-1", "turn/completed", finish("completed"));
    await assert.rejects(pending, /no thread/);
    assert.equal(env.store.conversations.length, 2);
    assert.equal(env.c.handOffs?.length, 1);
    assert.equal(env.store.conversations[0].handedOffFrom?.conversationId, "c");
  } finally {
    env.close();
  }
});

test("handing off needs a Code session at rest with something said in it", async () => {
  const env = setup();
  try {
    env.c.mode = "chat";
    await assert.rejects(
      env.engine.handOffConversation("c"),
      /Only Code sessions/,
    );
    env.c.mode = "code";
    env.c.incognito = true;
    await assert.rejects(env.engine.handOffConversation("c"), /incognito/);
    env.c.incognito = false;
    env.c.turns[1].status = "inProgress";
    await assert.rejects(env.engine.handOffConversation("c"), /still running/);
    env.c.turns = [];
    await assert.rejects(
      env.engine.handOffConversation("c"),
      /nothing to hand off/,
    );
    assert.equal(
      env.calls.some((call) => call.method === "thread/fork"),
      false,
    );
  } finally {
    env.close();
  }
});

test("the excerpt keeps the newest messages within its budget, oldest first", () => {
  const turns = Array.from({ length: 40 }, (_, i) =>
    turn(`t${i}`, "completed", `question ${i} ${"x".repeat(1400)}`),
  );
  turns.push({ ...turn("shell"), shell: true });
  const digest = transcriptDigest(turns);
  assert.ok(digest.length <= 30_000);
  assert.ok(digest.includes("question 39"));
  assert.ok(!digest.includes("question 0 "));
  assert.ok(digest.indexOf("question 38") < digest.indexOf("question 39"));
  assert.equal(transcriptDigest([]), "");
});

test("the first message names the session, brackets the note and asks for a short answer", () => {
  const prompt = handOffPrompt({
    title: "Fix uploads",
    note: ` ${"n".repeat(maxHandOffNoteLength + 10)} `,
    written: true,
  });
  assert.match(prompt, /"Fix uploads"/);
  assert.match(prompt, /<handoff-note>\n\nn+\n\n<\/handoff-note>/);
  assert.ok(prompt.length < maxHandOffNoteLength + 1500);
  assert.match(prompt, /Do not start working/);
  assert.match(
    handOffPrompt({ title: "t", note: "x", written: false }),
    /excerpt of its latest messages/,
  );
});

test("a context-window failure is told apart from other errors", () => {
  assert.equal(
    isContextLimitError(
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    ),
    true,
  );
  assert.equal(isContextLimitError("context_length_exceeded"), true);
  assert.equal(
    isContextLimitError("Your input exceeds the context window of this model"),
    true,
  );
  assert.equal(
    isContextLimitError(
      "The response reached the model's maximum output length.",
    ),
    false,
  );
  assert.equal(isContextLimitError("unexpected status 502"), false);
  assert.equal(isContextLimitError(undefined), false);
});
