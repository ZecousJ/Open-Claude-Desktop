import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import type { Conversation } from "../../shared/types";
function setup(call: (method: string, params: any) => Promise<any>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-branch-errors-"));
  const store = new Store(root);
  const c: Conversation = {
    id: "c",
    title: "Fixture",
    mode: "chat",
    providerId: "default",
    model: "m",
    threadId: "source",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: ["a", "b", "c"].map((id, i) => ({
      id,
      prompt: id,
      attachments: [],
      items: [],
      status: "completed",
      createdAt: i + 1,
    })),
  };
  store.conversations.push(c);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.ensure = async () => {};
  engine.rpc = { call } as any;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  return {
    store,
    c,
    engine,
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
test("failed native fork preserves the source history and its thread", async () => {
  const env = setup(async (method) => {
    assert.equal(method, "thread/fork");
    throw new Error("fork unavailable");
  });
  try {
    const before = structuredClone(env.c);
    await assert.rejects(
      env.engine.retryResponse("c", "b", "default", "m"),
      /fork unavailable/,
    );
    assert.deepEqual(env.c, before);
  } finally {
    env.close();
  }
});
test("failed replacement turn retains a selectable original branch and does not mark the original failed", async () => {
  const env = setup(async (method, params) => {
    if (method === "thread/fork") {
      assert.equal(params.lastTurnId, "a");
      return { thread: { id: "replacement" } };
    }
    assert.equal(method, "turn/start");
    throw new Error("provider refused");
  });
  try {
    await assert.rejects(
      env.engine.retryResponse("c", "b", "default", "m"),
      /provider refused/,
    );
    const replacement = env.c.turns.at(-1)!;
    assert.equal(replacement.status, "failed");
    assert.equal(env.c.savedBranches?.[0].turns[1].status, "completed");
    env.engine.selectReplyVersion("c", replacement.id, "b");
    assert.deepEqual(
      env.c.turns.map((t) => t.id),
      ["a", "b", "c"],
    );
    assert.equal(env.c.threadId, "source");
  } finally {
    env.close();
  }
});
test("a pending fork excludes concurrent submission and version selection", async () => {
  let release!: (value: any) => void;
  let started!: () => void;
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fork = new Promise((resolve) => {
    release = resolve;
  });
  const env = setup(async (method) => {
    if (method === "thread/fork") {
      started();
      return fork;
    }
    return { turn: { id: "new-turn" } };
  });
  try {
    const pending = env.engine.retryResponse("c", "b", "default", "m");
    await reached;
    assert.throws(
      () => env.engine.selectReplyVersion("c", "b", "b"),
      /submission/,
    );
    await assert.rejects(
      env.engine.retryResponse("c", "b", "default", "m"),
      /being created/,
    );
    release({ thread: { id: "fork" } });
    await pending;
    assert.equal(env.c.turns.length, 2);
    assert.throws(
      () => env.engine.selectReplyVersion("c", "new-turn", "b"),
      /Wait/,
    );
  } finally {
    env.close();
  }
});

test("editing forks before the replaced prompt and keeps reply versions separate", async () => {
  const env = setup(async (method, params) => {
    if (method === "thread/fork") {
      assert.equal(params.lastTurnId, "a");
      return { thread: { id: "edited-thread" } };
    }
    assert.equal(method, "turn/start");
    assert.equal(params.input[0].text, "edited b");
    return { turn: { id: "edited-b" } };
  });
  try {
    await env.engine.editPrompt("c", "b", "edited b", "default", "m");
    const edited = env.c.turns[1];
    edited.status = "completed";
    assert.equal(edited.prompt, "edited b");
    assert.notEqual(edited.responseGroupId, "b");
    assert.equal(edited.promptGroupId, "b");
    assert.throws(
      () => env.engine.selectReplyVersion("c", edited.id, "b"),
      /does not belong/,
    );
    env.engine.selectPromptVersion("c", edited.id, "b");
    assert.deepEqual(
      env.c.turns.map((t) => t.prompt),
      ["a", "b", "c"],
    );
    assert.equal(env.c.threadId, "source");
    env.engine.selectPromptVersion("c", "b", edited.id);
    assert.equal(env.c.threadId, "edited-thread");
    assert.equal(env.c.turns.length, 2);
  } finally {
    env.close();
  }
});

test("unchanged, blank, and failed edits leave original history intact", async () => {
  const env = setup(async () => {
    throw new Error("fork failed");
  });
  try {
    const before = structuredClone(env.c);
    for (const text of ["b", "  ", "edited"])
      await assert.rejects(
        env.engine.editPrompt("c", "b", text, "default", "m"),
      );
    assert.deepEqual(env.c, before);
  } finally {
    env.close();
  }
});
test("an incognito chat is not resumed or forked after the agent restarted", async () => {
  const calls: string[] = [];
  const env = setup(async (method) => {
    calls.push(method);
    return {};
  });
  try {
    env.c.incognito = true;
    await assert.rejects(
      env.engine.retryResponse("c", "b", "default", "m"),
      /incognito chat ended/,
    );
    await assert.rejects(
      env.engine.send({
        conversationId: "c",
        text: "again",
        mode: "chat",
        attachments: [],
        providerId: "default",
        model: "m",
      }),
      /incognito chat ended/,
    );
    assert.deepEqual(calls, []);
  } finally {
    env.close();
  }
});
