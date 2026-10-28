import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import type { Conversation } from "../../shared/types";

function setup(call: (method: string, params: any) => Promise<any>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-review-"));
  const store = new Store(root);
  const provider = store.settings.providers[0];
  const c: Conversation = {
    id: "c",
    title: "Session",
    mode: "code",
    providerId: provider.id,
    model: provider.models[0] ?? "m",
    threadId: "thread",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "a",
        prompt: "hi",
        attachments: [],
        items: [],
        status: "completed",
        createdAt: 1,
      },
    ],
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
  (engine as any).loaded.add("thread");
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

test("/review starts review/start inline on the session's thread and records a review turn", async () => {
  const calls: [string, any][] = [];
  const env = setup(async (method, params) => {
    calls.push([method, params]);
    return {};
  });
  try {
    const target = { type: "baseBranch", branch: "main" } as const;
    const result = await env.engine.startReview("c", target, "/review main");
    const run = calls.find(([m]) => m === "review/start")!;
    assert.deepEqual(run[1], {
      threadId: "thread",
      target,
      delivery: "inline",
    });
    const turn = result.turns.at(-1)!;
    assert.deepEqual(turn.review, target);
    assert.equal(turn.prompt, "/review main");
    assert.equal(turn.status, "inProgress");
    assert.ok(turn.id.startsWith("pending-"));
  } finally {
    env.close();
  }
});

test("a review that Codex refuses leaves no turn behind; running replies, empty sessions and non-Code sessions refuse it", async () => {
  const env = setup(async (method) => {
    if (method === "review/start") throw new Error("no repo");
    return {};
  });
  try {
    await assert.rejects(
      env.engine.startReview("c", { type: "uncommittedChanges" }),
      /no repo/,
    );
    assert.equal(env.c.turns.length, 1);
    env.c.turns[0].status = "inProgress";
    await assert.rejects(
      env.engine.startReview("c", { type: "uncommittedChanges" }),
      /still running/,
    );
    env.c.turns[0].status = "completed";
    env.c.turns.length = 0;
    await assert.rejects(
      env.engine.startReview("c", { type: "uncommittedChanges" }),
      /Send a message first/,
    );
    env.c.mode = "chat";
    await assert.rejects(
      env.engine.startReview("c", { type: "uncommittedChanges" }),
      /Code/,
    );
  } finally {
    env.close();
  }
});

test("a review turn can't be retried or edited", async () => {
  const env = setup(async () => ({}));
  try {
    await env.engine.startReview("c", { type: "uncommittedChanges" });
    const turn = env.c.turns.at(-1)!;
    turn.status = "completed";
    await assert.rejects(
      env.engine.retryResponse("c", turn.id, env.c.providerId, env.c.model),
      /can't be retried/,
    );
    await assert.rejects(
      env.engine.editPrompt(
        "c",
        turn.id,
        "other",
        env.c.providerId,
        env.c.model,
      ),
      /can't be edited/,
    );
  } finally {
    env.close();
  }
});
