/**
 * Cowork's Edit and Restart session from here on the last prompt reuse the
 * engine's editPrompt and retryResponse: the native thread is forked just
 * before the prompt, so the replaced reply stays a saved version and the
 * conversation keeps its mode and folder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import type { Conversation } from "../../shared/types";

function setup(call: (method: string, params: any) => Promise<any>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cowork-prompt-"));
  const store = new Store(root);
  const c: Conversation = {
    id: "w",
    title: "Cowork fixture",
    mode: "cowork",
    providerId: "default",
    model: "m",
    cwd: root,
    threadId: "source",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: ["first", "last"].map((id, i) => ({
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
    c,
    engine,
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Edit on the last Cowork prompt forks before it and sends the new text", async () => {
  const methods: string[] = [];
  const env = setup(async (method, params) => {
    methods.push(method);
    if (method === "thread/fork") {
      assert.equal(params.threadId, "source");
      assert.equal(params.lastTurnId, "first");
      return { thread: { id: "edited-thread" } };
    }
    assert.equal(method, "turn/start");
    assert.equal(params.threadId, "edited-thread");
    assert.equal(params.input[0].text, "edited last");
    return { turn: { id: "edited-turn" } };
  });
  try {
    const result = await env.engine.editPrompt(
      "w",
      "last",
      "edited last",
      "default",
      "m",
    );
    assert.deepEqual(methods, ["thread/fork", "turn/start"]);
    assert.equal(result.mode, "cowork");
    assert.deepEqual(
      env.c.turns.map((t) => t.prompt),
      ["first", "edited last"],
    );
    // The replaced reply is kept as a saved version, not deleted.
    assert.equal(env.c.savedBranches?.[0].turns.at(-1)?.prompt, "last");
  } finally {
    env.close();
  }
});

test("Restart session from here on the last Cowork prompt sends the same text again", async () => {
  const env = setup(async (method, params) => {
    if (method === "thread/fork") {
      assert.equal(params.lastTurnId, "first");
      return { thread: { id: "restart-thread" } };
    }
    assert.equal(method, "turn/start");
    assert.equal(params.input[0].text, "last");
    return { turn: { id: "restart-turn" } };
  });
  try {
    await env.engine.retryResponse("w", "last", "default", "m");
    assert.deepEqual(
      env.c.turns.map((t) => t.prompt),
      ["first", "last"],
    );
    assert.equal(env.c.turns.at(-1)?.id, "restart-turn");
    assert.equal(env.c.turns.at(-1)?.status, "inProgress");
    assert.equal(env.c.threadId, "restart-thread");
  } finally {
    env.close();
  }
});
