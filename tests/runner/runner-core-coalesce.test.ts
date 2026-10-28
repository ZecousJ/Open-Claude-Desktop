/**
 * Event coalescing and the event hub (runner/src/coalesce.ts, event-hub.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { AppEvent, Conversation } from "../../shared/types";
import type { RunnerFrame } from "../../shared/web-runner-frames";
import { Coalescer, coalesceKey } from "../../runner/src/coalesce";
import { EventHub } from "../../runner/src/event-hub";

const conversation = (id: string, title: string) =>
  ({ id, title, turns: [] }) as unknown as Conversation;
const conv = (id: string, title: string): AppEvent => ({
  type: "conversation",
  conversation: conversation(id, title),
});

function manualTimers() {
  const pending: (() => void)[] = [];
  return {
    setTimer: (cb: () => void) => {
      pending.push(cb);
      return pending.length;
    },
    clearTimer: () => {
      pending.length = 0;
    },
    fire() {
      const all = pending.splice(0);
      for (const cb of all) cb();
    },
  };
}

test("only conversation and engine events are coalesced", () => {
  assert.equal(coalesceKey(conv("a", "x")), "conversation:a");
  assert.equal(
    coalesceKey({ type: "engine", engine: { state: "ready" } }),
    "engine",
  );
  assert.equal(coalesceKey({ type: "approval-resolved", id: 1 }), undefined);
});

test("a side chat's answer so far keeps only the newest copy", () => {
  const text = (value: string): AppEvent => ({
    type: "side-chat-text",
    conversationId: "c",
    sideChatId: "s1",
    text: value,
  });
  assert.equal(coalesceKey(text("a")), "side-chat:s1");
  const sent: AppEvent[] = [];
  const timers = manualTimers();
  const c = new Coalescer({
    delayMs: 80,
    send: (e) => sent.push(e),
    ...timers,
  });
  c.push(text("It"));
  c.push(text("It said"));
  c.push(text("It said so."));
  assert.equal(sent.length, 0);
  timers.fire();
  assert.deepEqual(
    sent.map((e) => (e as any).text),
    ["It said so."],
  );
});

test("the newest copy of each conversation is sent once the window ends", () => {
  const sent: AppEvent[] = [];
  const timers = manualTimers();
  const c = new Coalescer({
    delayMs: 80,
    send: (e) => sent.push(e),
    ...timers,
  });
  c.push(conv("a", "1"));
  c.push(conv("b", "1"));
  c.push(conv("a", "2"));
  c.push(conv("a", "3"));
  assert.equal(sent.length, 0);
  timers.fire();
  assert.deepEqual(
    sent.map((e) => (e as any).conversation.id + (e as any).conversation.title),
    ["a3", "b1"],
  );
});

test("another event first sends what waits, in order", () => {
  const sent: AppEvent[] = [];
  const timers = manualTimers();
  const c = new Coalescer({
    delayMs: 80,
    send: (e) => sent.push(e),
    ...timers,
  });
  c.push(conv("a", "1"));
  c.push({ type: "approval-resolved", id: 5 });
  assert.deepEqual(
    sent.map((e) => e.type),
    ["conversation", "approval-resolved"],
  );
  assert.equal(c.waiting, 0);
  c.push(conv("a", "2"));
  c.dispose();
  timers.fire();
  assert.equal(sent.length, 2);
});

test("the hub sends event frames per user and drops frames over the limit", async () => {
  const frames: RunnerFrame[] = [];
  const logs: string[] = [];
  const hub = new EventHub({
    sink: { send: (f) => (frames.push(f), true) },
    delayMs: 1,
    maxFrameBytes: 400,
    log: (m) => logs.push(m),
  });
  hub.publish(1, conv("a", "short"));
  hub.publish(2, conv("a", "x".repeat(1000)));
  hub.flush(1);
  hub.flush(2);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], {
    t: "event",
    userId: 1,
    event: conv("a", "short"),
  });
  assert.equal(hub.counts.dropped, 1);
  assert.match(logs[0]!, /dropped a conversation event/);
});

test("a page to open goes after the user's waiting events", () => {
  const frames: RunnerFrame[] = [];
  const hub = new EventHub({
    sink: { send: (f) => (frames.push(f), true) },
    delayMs: 10_000,
  });
  hub.publish(3, conv("a", "1"));
  hub.openUrl(3, "/desktop-pay?order=1", "same-tab", "tab-12345678");
  assert.deepEqual(
    frames.map((f) => f.t),
    ["event", "open-url"],
  );
  assert.deepEqual(frames[1], {
    t: "open-url",
    userId: 3,
    url: "/desktop-pay?order=1",
    target: "same-tab",
    tabId: "tab-12345678",
  });
  hub.forget(3);
});
