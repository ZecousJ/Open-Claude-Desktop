import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import {
  beginCodeSessionLifecycle,
  assertCodeSessionSendAvailable,
} from "../../electron/conversations/code-lifecycle-guard";
import type { Conversation } from "../../shared/types";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f106-history-"));
  const store = new Store(root);
  const c: Conversation = {
    id: "source",
    title: "Source",
    mode: "code",
    providerId: "default",
    model: "m",
    cwd: "/inert",
    threadId: "original",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: ["one", "two"].map((id) => ({
      id,
      prompt: id,
      items: [],
      attachments: [],
      status: "completed",
      createdAt: 1,
    })),
  };
  store.conversations.push(c);
  store.flush();
  const events: unknown[] = [],
    calls: string[] = [];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    (event) => events.push(event),
  );
  engine.ensure = async () => {};
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  engine.rpc = {
    call: async (method: string) => {
      calls.push(method);
      return { thread: { id: "new-thread" } };
    },
  } as any;
  return {
    root,
    store,
    c,
    engine,
    events,
    calls,
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Code fork has fresh session ownership and restart-safe source/child references", async () => {
  const f = fixture();
  try {
    Object.assign(f.c, {
      rewind: {
        variant: "pending",
        index: 1,
        threadId: "old",
        turns: [],
        at: 1,
      },
      codeNewTask: { id: "op", text: "old" },
      worktree: { path: "/inert", origin: "/repo" },
      tokenUsage: { total: 10 },
      usage: { totalTokens: 10 },
      keepAwake: true,
      completedAt: 1,
      scheduledTaskId: "task",
      prAutoFix: { enabled: true },
      sessionAuthors: { ownerAccountUuid: "owner" },
    });
    const result = await f.engine.forkConversation(f.c.id, "one");
    for (const key of [
      "rewind",
      "codeNewTask",
      "worktree",
      "tokenUsage",
      "usage",
      "keepAwake",
      "completedAt",
      "scheduledTaskId",
      "prAutoFix",
    ])
      assert.equal((result as any)[key], undefined, key);
    assert.equal(result.cwd, "/inert");
    assert.deepEqual(result.sessionAuthors, f.c.sessionAuthors);
    const restored = new Store(f.root);
    assert.equal(
      restored.conversation(f.c.id).forks?.[0].conversationId,
      result.id,
    );
    assert.equal(restored.conversation(result.id).threadId, "new-thread");
    assert.equal(f.c.rewind?.threadId, "old");
  } finally {
    f.close();
  }
});

test("Code fork and rewind reject malformed and all reused native thread IDs", async () => {
  for (const operation of ["fork", "rewind"])
    for (const id of [
      undefined,
      42,
      "",
      " ",
      "original",
      "saved",
      "undo",
      "other",
      "routed",
      "loaded",
    ]) {
      const f = fixture();
      try {
        f.c.savedBranches = [
          {
            id: "b",
            threadId: "saved",
            providerId: "default",
            model: "m",
            turns: [],
            visited: 1,
          },
        ];
        f.c.rewind = {
          variant: "pending",
          index: 1,
          threadId: "undo",
          turns: [],
          at: 1,
        };
        f.store.conversations.push({
          ...structuredClone(f.c),
          id: "other-c",
          threadId: "other",
        });
        f.engine.routes.set("routed", "somewhere");
        f.engine.loaded.add("loaded");
        f.engine.rpc = { call: async () => ({ thread: { id } }) } as any;
        const before = structuredClone(f.store.conversations);
        await assert.rejects(
          operation === "fork"
            ? f.engine.forkConversation(f.c.id, "one")
            : f.engine.rewindConversation(f.c.id, "two"),
        );
        assert.deepEqual(f.store.conversations, before);
        assert.equal(f.engine.routes.has("new-thread"), false);
      } finally {
        f.close();
      }
    }
});

test("Code fork, rewind and Undo publish nothing on atomic history write failure", async () => {
  for (const operation of ["fork", "rewind", "undo"]) {
    const f = fixture();
    const write = f.store.write.bind(f.store);
    try {
      if (operation === "undo")
        await f.engine.rewindConversation(f.c.id, "two");
      const before = structuredClone(f.store.conversations),
        disk = fs.readFileSync(path.join(f.root, "conversations.json"), "utf8");
      f.events.length = 0;
      f.store.write = (name, value) => {
        if (name === "conversations.json") throw Error("disk full");
        write(name, value);
      };
      await assert.rejects(
        operation === "fork"
          ? f.engine.forkConversation(f.c.id, "one")
          : operation === "rewind"
            ? f.engine.rewindConversation(f.c.id, "two")
            : f.engine.swapRewind(f.c.id),
        /disk full/,
      );
      assert.deepEqual(f.store.conversations, before);
      assert.equal(
        fs.readFileSync(path.join(f.root, "conversations.json"), "utf8"),
        disk,
      );
      assert.equal(f.events.length, 0);
      assert.doesNotThrow(() => assertCodeSessionSendAvailable(f.c));
    } finally {
      f.store.write = write;
      f.close();
    }
  }
});

test("Code history holds the shared lifecycle/send lock throughout native awaits and releases it", async () => {
  const f = fixture();
  let resume!: () => void;
  const gate = new Promise<void>((r) => (resume = r));
  try {
    f.engine.ensure = async () => {
      await gate;
    };
    const work = f.engine.forkConversation(f.c.id, "one");
    assert.throws(() => assertCodeSessionSendAvailable(f.c), /finish/);
    assert.throws(() => beginCodeSessionLifecycle(f.c), /progress/);
    await assert.rejects(f.engine.rewindConversation(f.c.id, "two"), /finish/);
    resume();
    await work;
    assert.doesNotThrow(() => assertCodeSessionSendAvailable(f.c));
  } finally {
    resume();
    f.close();
  }
});

test("Code history rejects late account, stop, RPC and ownership changes without publishing", async () => {
  for (const mutation of [
    "account",
    "stop",
    "rpc",
    "cwd",
    "worktree",
    "mode",
  ]) {
    const f = fixture();
    let active = true;
    try {
      f.engine.rpc = {
        call: async (method: string) => {
          if (method === "thread/fork") {
            if (mutation === "account") active = false;
            if (mutation === "stop") f.engine.intentionalStop = true;
            if (mutation === "rpc") f.engine.rpc = {} as any;
            if (mutation === "cwd") f.c.cwd = "/changed";
            if (mutation === "worktree")
              f.c.worktree = { state: "deleted" } as any;
            if (mutation === "mode") f.c.mode = "chat";
          }
          return { thread: { id: "new-thread" } };
        },
      } as any;
      await assert.rejects(
        f.engine.forkConversation(
          f.c.id,
          "one",
          undefined,
          undefined,
          () => active,
        ),
        /changed/,
      );
      assert.equal(f.store.conversations.length, 1);
      assert.equal(f.c.forks, undefined);
      assert.equal(f.engine.routes.has("new-thread"), false);
      assert.doesNotThrow(() => beginCodeSessionLifecycle(f.c)());
    } finally {
      f.close();
    }
  }
});

test("zero-turn rewind and repeated Undo/Redo survive Store reload", async () => {
  const f = fixture();
  try {
    await f.engine.rewindConversation(f.c.id, "one");
    assert.equal(f.c.threadId, undefined);
    assert.equal(f.c.turns.length, 0);
    let disk = new Store(f.root);
    assert.equal(disk.conversation(f.c.id).rewind?.turns.length, 2);
    await f.engine.swapRewind(f.c.id);
    assert.equal(f.c.turns.length, 2);
    assert.equal(f.c.threadId, "original");
    await f.engine.swapRewind(f.c.id);
    assert.equal(f.c.turns.length, 0);
    disk = new Store(f.root);
    assert.equal(disk.conversation(f.c.id).rewind?.threadId, "original");
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test("real Code saved-branch fork preserves that branch boundary and sends only in the new session", async () => {
  const f = fixture();
  try {
    f.c.savedBranches = [
      {
        id: "saved",
        providerId: "default",
        model: "m",
        threadId: "saved-thread",
        turns: [{ ...f.c.turns[0], id: "saved-turn" }],
        visited: 1,
      },
    ];
    let sent: any;
    f.engine.send = async (input) => {
      sent = input;
      return structuredClone(f.store.conversation(input.conversationId!));
    };
    const result = await f.engine.forkConversation(
      f.c.id,
      "saved-turn",
      "continue",
      "saved",
    );
    assert.equal(result.turns[0].id, "saved-turn");
    assert.equal(sent.conversationId, result.id);
    assert.equal(sent.text, "continue");
    assert.equal(f.c.threadId, "original");
    assert.equal(f.c.turns.length, 2);
    assert.equal(result.savedBranches, undefined);
  } finally {
    f.close();
  }
});

test("duplicate Code boundary and corrupt Undo snapshots fail without publishing", async () => {
  const f = fixture();
  try {
    f.c.turns[1].id = "one";
    await assert.rejects(f.engine.forkConversation(f.c.id, "one"), /ambiguous/);
    await assert.rejects(
      f.engine.rewindConversation(f.c.id, "one"),
      /ambiguous/,
    );
    f.c.rewind = {
      index: -1,
      variant: "pending",
      threadId: "old",
      turns: [],
      at: 1,
    };
    await assert.rejects(f.engine.swapRewind(f.c.id), /invalid/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});
