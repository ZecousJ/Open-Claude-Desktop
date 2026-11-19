import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { CodeSendStart } from "../../electron/engine/code-send-start";
import { CodeRunCapacity } from "../../runner/src/code-run-capacity";
import type { AppEvent, Conversation, Turn } from "../../shared/types";

function execution(conversationId: string = randomUUID()) {
  const turn: Turn = {
    id: "pending-" + randomUUID(), prompt: "", attachments: [], items: [], status: "inProgress", createdAt: 1,
  };
  const conversation: Conversation = {
    id: conversationId, title: "Code", mode: "code", providerId: "test", model: "test", pinned: false,
    archived: false, createdAt: 1, updatedAt: 1, turns: [turn],
  };
  const start = new CodeSendStart();
  const events = new Set<(event: AppEvent) => void>();
  return {
    userId: 1, conversation, turn, start,
    subscribe(listener: (event: AppEvent) => void) {
      events.add(listener);
      return () => { events.delete(listener); };
    },
    publish() {
      for (const listener of events) listener({ type: "conversation", conversation: structuredClone(conversation) });
    },
  };
}

test("a new queued turn waits for acknowledgement that its predecessor released capacity", async () => {
  const operations: string[] = [];
  let acknowledge = () => {};
  const finish = new Promise<void>(resolve => { acknowledge = resolve; });
  const capacity = new CodeRunCapacity(async (op) => {
    operations.push(op);
    return op === "run.acquire" ? { deadlineMs: Date.now() + 60_000 } : finish;
  }, () => {});
  capacity.welcome(true);
  try {
    const first = execution();
    (await capacity.acquire(first))?.track(first.turn);
    first.turn.id = randomUUID();
    first.turn.status = "completed";
    first.publish();
    first.publish();
    const queued = execution(first.conversation.id);
    const next = capacity.acquire(queued);
    await setImmediate();
    assert.deepEqual(operations, ["run.acquire", "run.finish"]);
    acknowledge();
    (await next)?.track(queued.turn);
    assert.deepEqual(operations, ["run.acquire", "run.finish", "run.acquire"]);
  } finally { capacity.down(); }
});

test("a stale owner's revoke cannot stop a Code attempt; the owning link's loss does", async () => {
  let id = "";
  let stops = 0;
  const capacity = new CodeRunCapacity(async (op, _userId, body) => {
    assert.equal(op, "run.acquire");
    assert("runId" in body && typeof body.runId === "string");
    id = body.runId;
    return { deadlineMs: Date.now() + 60_000 };
  }, () => {});
  capacity.welcome(true);
  const run = execution();
  try {
    (await capacity.acquire(run))?.track(run.turn);
    run.start.dispatched(async () => { stops++; return { status: "accepted" }; });
    capacity.expire(run.userId + 1, id);
    assert.equal(stops, 0);
    capacity.down();
    assert.equal(stops, 1);
    capacity.welcome(true);
    capacity.expire(run.userId, id);
    assert.equal(stops, 1);
  } finally { capacity.down(); }
});

test("a lost App Server receipt retains the slot until an exact settlement or revoke", async () => {
  const operations: string[] = [];
  let id = "";
  const capacity = new CodeRunCapacity(async (op, _userId, body) => {
    operations.push(op);
    assert("runId" in body && typeof body.runId === "string");
    id = body.runId;
    return { deadlineMs: Date.now() + 60_000 };
  }, () => {});
  capacity.welcome(true);
  const run = execution();
  try {
    (await capacity.acquire(run))?.track(run.turn);
    run.start.dispatchUncertain = true;
    run.turn.status = "failed";
    run.publish();
    assert.deepEqual(operations, ["run.acquire"]);
    capacity.expire(run.userId, id);
    assert.deepEqual(operations, ["run.acquire", "run.finish"]);
  } finally { capacity.down(); }
});
