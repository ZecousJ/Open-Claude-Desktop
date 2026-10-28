import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { pendingPolicy } from "../../shared/client-policy";
import type { Conversation, Turn } from "../../shared/types";

type Call = { method: string; params: any };

const turn = (id: string, status: Turn["status"] = "completed"): Turn => ({
  id,
  prompt: id,
  attachments: [],
  items: [{ id: `${id}-m`, type: "agentMessage", text: `answer ${id}` }],
  status,
  createdAt: 1,
});

function setup(turns: Turn[] = [turn("a"), turn("b")]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-side-"));
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
    mode: "chat",
    providerId: "p",
    model: "m",
    threadId: "main",
    cwd: root,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns,
  };
  store.conversations.push(c);
  const calls: Call[] = [];
  const events: unknown[] = [];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    (event) => events.push(event),
  );
  engine.policy = () => ({ ...pendingPolicy, update: undefined });
  engine.ensure = async () => {};
  let forks = 0;
  engine.rpc = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/fork")
        return { thread: { id: `side-${++forks}` } };
      if (method === "turn/start") return { turn: { id: `turn-${forks}` } };
      return {};
    },
    async stop() {},
  } as any;
  (engine as any).windowsSandbox = {
    assertReady() {},
    async ensureReady() {},
    reset() {},
  };
  const internals = engine as any;
  internals.loaded.add("main");
  internals.routes.set("main", "c");
  /** The agent says something on a thread, as the app-server notifies it. */
  const notify = (threadId: string, method: string, params: object) =>
    internals.notification({ method, params: { threadId, ...params } });
  /** Lets a started question reach turn/start. */
  const started = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    store,
    c,
    engine,
    calls,
    events,
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

test("a side question runs on an ephemeral read-only fork and leaves the conversation as it is", async () => {
  const env = setup();
  try {
    const before = structuredClone(env.c);
    const pending = env.engine.askSideChat("c", "s1", "  What did b say?  ");
    await env.started();
    const fork = env.calls.find((call) => call.method === "thread/fork")!;
    assert.equal(fork.params.threadId, "main");
    assert.equal(fork.params.lastTurnId, "b");
    assert.equal(fork.params.ephemeral, true);
    assert.equal(fork.params.sandbox, "read-only");
    assert.equal(fork.params.approvalPolicy, "never");
    assert.match(fork.params.developerInstructions, /This is a side chat/);
    assert.equal("dynamicTools" in fork.params, false);
    const start = env.calls.find((call) => call.method === "turn/start")!;
    assert.equal(start.params.threadId, "side-1");
    assert.deepEqual(start.params.input, [
      { type: "text", text: "What did b say?", text_elements: [] },
    ]);
    // The reply streams in and finishes.
    env.notify("side-1", "item/agentMessage/delta", {
      itemId: "m1",
      delta: "It said ",
    });
    env.notify("side-1", "item/completed", say("m1", "It said answer b."));
    env.notify("side-1", "turn/completed", finish("completed"));
    assert.equal(await pending, "It said answer b.");
    // Nothing of the conversation changed, and nothing was sent to the window.
    assert.deepEqual(env.c, before);
    assert.equal(
      env.events.some((event) => (event as any).type === "conversation"),
      false,
    );
    // The main thread was not loaded again.
    assert.equal(
      env.calls.some((call) => call.method === "thread/resume"),
      false,
    );
  } finally {
    env.close();
  }
});

test("a side chat's later questions use the same fork; Clear releases it", async () => {
  const env = setup();
  try {
    const first = env.engine.askSideChat("c", "s1", "One?");
    await env.started();
    env.notify("side-1", "item/completed", say("m1", "One."));
    env.notify("side-1", "turn/completed", finish("completed"));
    assert.equal(await first, "One.");
    const second = env.engine.askSideChat("c", "s1", "Two?");
    await env.started();
    assert.equal(
      env.calls.filter((call) => call.method === "thread/fork").length,
      1,
    );
    assert.equal(
      env.calls.filter((call) => call.method === "turn/start").length,
      2,
    );
    // One question at a time.
    await assert.rejects(
      env.engine.askSideChat("c", "s1", "Three?"),
      /still answering/,
    );
    // Clear stops the running question and lets the fork go.
    const stopped = assert.rejects(second, /closed/);
    await env.engine.endSideChat("c", "s1");
    await stopped;
    const methods = env.calls.map((call) => call.method);
    assert.ok(methods.includes("turn/interrupt"));
    assert.ok(methods.includes("thread/unsubscribe"));
    // The released fork's late output goes nowhere.
    env.notify("side-1", "turn/completed", finish("completed"));
    const again = env.engine.askSideChat("c", "s1", "Four?");
    await env.started();
    assert.equal(
      env.calls.filter((call) => call.method === "thread/fork").length,
      2,
    );
    env.notify("side-2", "item/completed", say("m2", "Four."));
    env.notify("side-2", "turn/completed", finish("completed"));
    assert.equal(await again, "Four.");
  } finally {
    env.close();
  }
});

test("a side question works while the conversation is running and forks at its last finished turn", async () => {
  const env = setup([turn("a"), turn("b", "inProgress")]);
  try {
    const pending = env.engine.askSideChat("c", "s1", "Quick?");
    await env.started();
    const fork = env.calls.find((call) => call.method === "thread/fork")!;
    assert.equal(fork.params.lastTurnId, "a");
    assert.equal(
      env.calls.some((call) => call.method === "thread/resume"),
      false,
    );
    env.notify("side-1", "item/completed", say("m1", "Yes."));
    env.notify("side-1", "turn/completed", finish("completed"));
    assert.equal(await pending, "Yes.");
    // The running turn is still the conversation's own.
    assert.equal(env.c.turns[1].status, "inProgress");
    env.notify("main", "item/agentMessage/delta", {
      turnId: "b",
      itemId: "b-m",
      delta: "!",
    });
    assert.equal(env.c.turns[1].items.at(-1)?.text, "answer b!");
  } finally {
    env.close();
  }
});

test("a side chat needs a finished turn, and a failed or stopped answer says so", async () => {
  const env = setup([turn("a", "inProgress")]);
  try {
    await assert.rejects(
      env.engine.askSideChat("c", "s1", "Now?"),
      /available once this session starts/,
    );
    assert.equal(
      env.calls.some((call) => call.method === "thread/fork"),
      false,
    );
    await assert.rejects(
      env.engine.askSideChat("c", "s1", "  "),
      /Enter a question/,
    );
    env.c.turns[0].status = "completed";
    const failed = env.engine.askSideChat("c", "s1", "Fails?");
    await env.started();
    env.notify(
      "side-1",
      "turn/completed",
      finish("failed", "unexpected status 502 http://127.0.0.1:9/v1"),
    );
    await assert.rejects(failed, (error: Error) => {
      assert.match(error.message, /Couldn’t get an answer/);
      assert.doesNotMatch(error.message, /502|127\.0\.0\.1/);
      return true;
    });
    // The fork stays for the next question after a failure.
    const empty = env.engine.askSideChat("c", "s1", "Empty?");
    await env.started();
    env.notify("side-1", "turn/completed", finish("completed"));
    await assert.rejects(empty, /Couldn’t get an answer/);
    const cut = env.engine.askSideChat("c", "s1", "Cut?");
    await env.started();
    env.notify("side-1", "turn/completed", finish("interrupted"));
    await assert.rejects(cut, /stopped/);
    assert.equal(
      env.calls.filter((call) => call.method === "thread/fork").length,
      1,
    );
  } finally {
    env.close();
  }
});

test("a side chat belongs to its conversation, and stopping the agent ends the question", async () => {
  const env = setup();
  try {
    env.store.conversations.push({ ...structuredClone(env.c), id: "other" });
    const pending = env.engine.askSideChat("c", "s1", "Wait?");
    await env.started();
    await assert.rejects(
      env.engine.askSideChat("other", "s1", "Mine?"),
      /another conversation/,
    );
    const ended = assert.rejects(pending, /agent stopped/);
    await env.engine.stop();
    await ended;
  } finally {
    env.close();
  }
});

const sideTexts = (events: unknown[]) =>
  events
    .filter((event) => (event as any).type === "side-chat-text")
    .map((event) => (event as any).text);

test("the answer streams to the window as the text so far, and the call still resolves with the whole", async () => {
  const env = setup();
  try {
    const pending = env.engine.askSideChat("c", "s1", "What did b say?");
    await env.started();
    env.notify("side-1", "item/agentMessage/delta", {
      itemId: "m1",
      delta: "It said ",
    });
    env.notify("side-1", "item/agentMessage/delta", {
      itemId: "m1",
      delta: "answer b.",
    });
    // A second message follows the first; an empty one adds nothing.
    env.notify("side-1", "item/agentMessage/delta", {
      itemId: "m2",
      delta: "  ",
    });
    env.notify("side-1", "item/agentMessage/delta", {
      itemId: "m3",
      delta: "More.",
    });
    env.notify("side-1", "item/completed", say("m1", "It said answer b."));
    env.notify("side-1", "turn/completed", finish("completed"));
    assert.equal(await pending, "It said answer b.\n\nMore.");
    assert.deepEqual(sideTexts(env.events), [
      "It said",
      "It said answer b.",
      "It said answer b.\n\nMore.",
    ]);
    const first = env.events.find(
      (event) => (event as any).type === "side-chat-text",
    );
    assert.deepEqual(first, {
      type: "side-chat-text",
      conversationId: "c",
      sideChatId: "s1",
      text: "It said",
    });
    // Late output after the answer ended is not sent.
    const count = env.events.length;
    env.notify("side-1", "item/agentMessage/delta", {
      itemId: "m9",
      delta: "late",
    });
    assert.equal(env.events.length, count);
  } finally {
    env.close();
  }
});

test("a handoff note is written without streaming to the window", async () => {
  const env = setup();
  try {
    const internals = env.engine as any;
    const note = internals.sides.ask("c", "note", "Write the note", "Do it");
    await env.started();
    env.notify("side-1", "item/agentMessage/delta", {
      itemId: "m1",
      delta: "The note.",
    });
    env.notify("side-1", "turn/completed", finish("completed"));
    assert.equal(await note, "The note.");
    assert.deepEqual(sideTexts(env.events), []);
  } finally {
    env.close();
  }
});

test("Stop interrupts the fork's turn and keeps the text written so far", async () => {
  const env = setup();
  try {
    const pending = env.engine.askSideChat("c", "s1", "Long one?");
    await env.started();
    env.notify("side-1", "item/agentMessage/delta", {
      itemId: "m1",
      delta: "Well, ",
    });
    await env.engine.interruptSideChat("c", "s1");
    const interrupt = env.calls.find(
      (call) => call.method === "turn/interrupt",
    )!;
    assert.deepEqual(interrupt.params, {
      threadId: "side-1",
      turnId: "turn-1",
    });
    env.notify("side-1", "turn/completed", finish("interrupted"));
    assert.equal(await pending, "Well,");
    // The fork stays for the next question, and stopping again is quiet.
    await env.engine.interruptSideChat("c", "s1");
    const next = env.engine.askSideChat("c", "s1", "Again?");
    await env.started();
    assert.equal(
      env.calls.filter((call) => call.method === "thread/fork").length,
      1,
    );
    env.notify("side-1", "item/completed", say("m2", "Yes."));
    env.notify("side-1", "turn/completed", finish("completed"));
    assert.equal(await next, "Yes.");
  } finally {
    env.close();
  }
});

test("Stop before any text rejects as stopped; before the turn started, no turn starts", async () => {
  const env = setup();
  try {
    const empty = env.engine.askSideChat("c", "s1", "Quiet?");
    await env.started();
    await env.engine.interruptSideChat("c", "s1");
    env.notify("side-1", "turn/completed", finish("interrupted"));
    await assert.rejects(empty, /stopped/);
    // Stop pressed while the fork is still being made.
    const early = env.engine.askSideChat("c", "s2", "Early?");
    await env.engine.interruptSideChat("c", "s2");
    await assert.rejects(early, /stopped/);
    assert.equal(
      env.calls.filter((call) => call.method === "turn/start").length,
      1,
    );
    // Nothing is being answered any more: stopping is quiet.
    await env.engine.interruptSideChat("c", "s2");
    await env.engine.interruptSideChat("c", "nobody");
  } finally {
    env.close();
  }
});
