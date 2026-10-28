import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import type { Conversation } from "../../shared/types";

function setup(call: (method: string, params: any) => Promise<any>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-shell-"));
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

test("Bash mode runs the line through thread/shellCommand and records a shell turn", async () => {
  const calls: [string, any][] = [];
  const env = setup(async (method, params) => {
    calls.push([method, params]);
    return {};
  });
  try {
    const result = await env.engine.runShellCommand("c", "ls | wc -l");
    const run = calls.find(([m]) => m === "thread/shellCommand")!;
    assert.deepEqual(run[1], { threadId: "thread", command: "ls | wc -l" });
    const turn = result.turns.at(-1)!;
    assert.equal(turn.shell, true);
    assert.equal(turn.prompt, "ls | wc -l");
    assert.equal(turn.status, "inProgress");
    assert.ok(turn.id.startsWith("pending-"));
  } finally {
    env.close();
  }
});

test("a shell command that Codex refuses leaves no turn behind; running replies and non-Code sessions refuse it", async () => {
  const env = setup(async (method) => {
    if (method === "thread/shellCommand") throw new Error("no shell");
    return {};
  });
  try {
    await assert.rejects(env.engine.runShellCommand("c", "pwd"), /no shell/);
    assert.equal(env.c.turns.length, 1);
    await assert.rejects(
      env.engine.runShellCommand("c", "  "),
      /Enter a shell/,
    );
    env.c.turns[0].status = "inProgress";
    await assert.rejects(
      env.engine.runShellCommand("c", "pwd"),
      /still running/,
    );
    env.c.turns[0].status = "completed";
    env.c.mode = "chat";
    await assert.rejects(env.engine.runShellCommand("c", "pwd"), /Code/);
  } finally {
    env.close();
  }
});

test("a shell turn can't be retried or edited", async () => {
  const env = setup(async () => ({}));
  try {
    await env.engine.runShellCommand("c", "pwd");
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
