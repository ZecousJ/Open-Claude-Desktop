/** Actual Engine notification → native transcript → Store reopen; no RPC or model. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { finishTurn } from "../../shared/activity";
import { registerExperimentalCodeSessions } from "../../electron/official-ui/native/code-sessions";
import type { Conversation } from "../../shared/types";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-f095-"));
  const store = new Store(root);
  const c: Conversation = {
    id: "fixture",
    mode: "code",
    title: "History fixture",
    providerId: "inert",
    model: "inert",
    threadId: "thread",
    cwd: root,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "turn",
        prompt: "fixture",
        attachments: [],
        items: [],
        createdAt: 1,
        status: "inProgress",
      },
    ],
  };
  store.conversations.push(c);
  const listeners = new Set<(event: any) => void>();
  const engine = new Engine(
    store,
    "unused",
    () => "",
    (event) => {
      for (const listener of listeners) listener(event);
    },
  );
  const internals = engine as any;
  internals.routes.set("thread", c.id);
  const events: any[] = [],
    handlers = new Map<string, any>();
  let rpcCalls = 0;
  engine.rpc = {
    call: async () => {
      rpcCalls++;
      throw Error("No RPC is expected for replay");
    },
  } as any;
  const closeNative = registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "fixture-owner" }),
      sessionIdentity: () => 1,
      isCurrent: () => true,
      localLoadConversation: async (id: string) =>
        structuredClone(store.conversation(id)),
      localCall: async (name: string) => {
        assert.equal(name, "snapshot");
        return { approvals: [] };
      },
      onEvent: (fn: any) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      log: (...args: unknown[]) => {
        throw Error("Unexpected native log " + JSON.stringify(args));
      },
    },
    on: (name: string, fn: any) => handlers.set(name, fn),
    emit: (_a: string, _b: string, event: any) => events.push(event),
  } as any);
  const notify = (method: string, params: any) =>
    internals.notification({
      method,
      params: { threadId: "thread", turnId: "turn", ...params },
    });
  return {
    root,
    store,
    c,
    events,
    handlers,
    notify,
    rpcCalls: () => rpcCalls,
    async flushEvents() {
      internals.changed(c, true);
      await new Promise((resolve) => setImmediate(resolve));
    },
    close() {
      closeNative();
      for (const timer of internals.notificationTimer.values())
        clearTimeout(timer);
      internals.notificationTimer.clear();
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("actual Engine unknown records survive Store reopen without blocking native history", async () => {
  const h = setup();
  try {
    h.notify("item/started", {
      item: {
        id: "unknown",
        type: "futureActivity",
        privatePayload: "PRIVATE_SENTINEL",
        reasoning: "RAW_SENTINEL",
      },
    });
    await h.flushEvents();
    assert.equal(h.events.filter((e) => e.type === "message").length, 1);
    h.notify("item/completed", {
      item: {
        id: "unknown",
        type: "futureActivity",
        privatePayload: "PRIVATE_SENTINEL",
      },
    });
    h.notify("item/completed", {
      item: { id: "reply", type: "agentMessage", text: "Visible response" },
    });
    const beforeCompletion = h.events.length;
    finishTurn(h.c.turns[0], "completed");
    await h.flushEvents();
    const history = await h.handlers.get("LocalSessions.getTranscript")(
      "local_fixture",
    );
    assert.equal(history.length, 3);
    assert.equal(history[1].uuid, "turn:item:unknown");
    assert.deepEqual(history[1].claudexUnsupported, ["futureActivity"]);
    assert.deepEqual(history[1].message.content, []);
    assert.doesNotMatch(
      JSON.stringify(history),
      /PRIVATE_SENTINEL|RAW_SENTINEL/,
    );
    h.store.flush();
    const reopened = new Store(h.root).conversation(h.c.id);
    assert.equal(reopened.turns[0].items[0].privatePayload, "PRIVATE_SENTINEL");
    assert.deepEqual(reopened.turns[0].items, h.c.turns[0].items);
    const completed = h.events.slice(beforeCompletion);
    assert.deepEqual(
      completed.map((e) => e.type),
      ["session_updated", "message", "message", "close"],
    );
    assert.deepEqual(
      completed.slice(1, 3).map((e) => e.message),
      history.slice(1),
    );
    const page = await h.handlers.get("LocalSessions.getTranscriptPage")(
      "local_fixture",
      history[2].uuid,
      1,
    );
    assert.deepEqual(page.messages, [history[1]]);
    assert.equal(h.rpcCalls(), 0);
  } finally {
    h.close();
  }
});

test("saved long mixed history reconstructs via native pages after Store reload", async () => {
  const h = setup();
  try {
    h.c.turns = Array.from({ length: 600 }, (_, i) => ({
      id: "saved-" + i,
      prompt: "Prompt " + i,
      attachments: [],
      status: "completed" as const,
      createdAt: i + 1,
      items: [
        { id: "reply", type: "agentMessage", text: "Reply " + i },
        ...(i % 20 === 0
          ? [
              {
                id: "future",
                type: "futureActivity",
                privatePayload: "PRIVATE_SENTINEL",
              },
            ]
          : []),
      ],
    }));
    h.store.flush();
    const reopened = new Store(h.root).conversation(h.c.id);
    assert.equal(reopened.turns.length, 600);
    h.c.turns = reopened.turns;
    const tail = await h.handlers.get("LocalSessions.getTranscriptTail")(
      "local_fixture",
      200,
    );
    let rows = tail.messages;
    let more = tail.hasMore;
    while (more) {
      const page = await h.handlers.get("LocalSessions.getTranscriptPage")(
        "local_fixture",
        rows[0].uuid,
        137,
      );
      assert.equal(page.found, true);
      rows = [...page.messages, ...rows];
      more = page.hasMore;
    }
    assert.equal(rows.length, 1230);
    assert.equal(new Set(rows.map((r: any) => r.uuid)).size, rows.length);
    assert.deepEqual(
      rows,
      await h.handlers.get("LocalSessions.getTranscript")("local_fixture"),
    );
    assert.equal(rows.filter((r: any) => r.claudexUnsupported).length, 30);
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_SENTINEL/);
    assert.equal(h.rpcCalls(), 0);
  } finally {
    h.close();
  }
});
