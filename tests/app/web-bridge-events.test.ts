import assert from "node:assert/strict";
import test from "node:test";
import type { AppEvent, Conversation, Snapshot } from "../../shared/types";
import { webHost } from "../../shared/host";
import {
  reconnectMaxMs,
  unavailableRetryMs,
} from "../../shared/web-client/events";
import { FakeClock, flush, signedInBridge } from "./web-bridge-fakes.test.ts";

const conversation = (id: string, title = id) =>
  ({ id, title, turns: [] }) as unknown as Conversation;
const event = (seq: number, value: AppEvent) => ({
  t: "event",
  seq,
  event: value,
});

async function connected() {
  const clock = new FakeClock();
  const setup = await signedInBridge(
    (method) =>
      method === "snapshot"
        ? ({ conversations: [], platform: "linux" } as unknown as Snapshot)
        : null,
    { clock },
  );
  const socket = setup.tab.sockets.at(-1)!;
  socket.open();
  return { ...setup, clock, socket };
}

test("the stream opens with a one-time ticket in the sub-protocols, never the URL", async () => {
  const { tab, socket, bridge } = await connected();
  assert.equal(socket.url, "wss://claudex.example/api/v1/claudex/web/events");
  assert.equal(socket.protocols[0], "claudex.v1");
  assert.match(socket.protocols[1]!, /^ticket\.[A-Za-z0-9_-]{43}$/);
  const ticket = tab.requests.find((r) =>
    r.url.endsWith("/auth/events-ticket"),
  )!;
  assert.equal(ticket.headers.get("authorization"), "Bearer at-1");
  const tabId = ticket.headers.get("x-claudex-web-tab");
  assert.deepEqual(ticket.body, { tabId });
  const [hello, presence] = socket.frames();
  assert.deepEqual(hello, { t: "hello", v: 1, tabId });
  assert.deepEqual(presence, { t: "presence", visible: true, focused: true });
  assert.equal(bridge.stream.connected, false);
  socket.receive({ t: "ready", v: 1, seq: 0, resumed: false });
  assert.equal(bridge.stream.connected, true);
});

test("events reach the window once, in order", async () => {
  const { socket, events } = await connected();
  socket.receive({ t: "ready", v: 1, seq: 4, resumed: false });
  socket.receive(
    event(5, { type: "conversation", conversation: conversation("a") }),
  );
  socket.receive(
    event(5, { type: "conversation", conversation: conversation("a") }),
  );
  socket.receive(event(6, { type: "approval-resolved", id: 1 }));
  socket.receive("{not json");
  socket.receive({ t: "pong" });
  assert.deepEqual(
    events.map((e) => e.type),
    ["conversation", "approval-resolved"],
  );
});

test("a side chat's answer so far reaches the window as it was sent", async () => {
  const { socket, events } = await connected();
  socket.receive({ t: "ready", v: 1, seq: 0, resumed: false });
  const text = (value: string): AppEvent => ({
    type: "side-chat-text",
    conversationId: "a",
    sideChatId: "s1",
    text: value,
  });
  socket.receive(event(1, text("It said")));
  socket.receive(event(2, text("It said so.")));
  assert.deepEqual(events, [text("It said"), text("It said so.")]);
});

test("a reconnect resumes after the last event; a missed range resyncs", async () => {
  const { socket, tab, clock, events } = await connected();
  socket.receive({ t: "ready", v: 1, seq: 0, resumed: false });
  socket.receive(event(1, { type: "approval-resolved", id: 1 }));
  socket.receive(event(2, { type: "approval-resolved", id: 2 }));
  socket.drop(1006);
  await clock.advance(reconnectMaxMs);
  const second = tab.sockets.at(-1)!;
  assert.notEqual(second, socket);
  second.open();
  assert.deepEqual(second.frames()[0].lastSeq, 2);
  second.receive({ t: "ready", v: 1, seq: 2, resumed: true });
  second.receive(event(3, { type: "approval-resolved", id: 3 }));
  await clock.advance(1000);
  assert.equal(events.filter((e) => e.type === "resync").length, 0);
  second.drop(1006);
  await clock.advance(reconnectMaxMs);
  const third = tab.sockets.at(-1)!;
  third.open();
  assert.equal(third.frames()[0].lastSeq, 3);
  third.receive({ t: "ready", v: 1, seq: 900, resumed: false });
  await clock.advance(200);
  assert.equal(events.filter((e) => e.type === "resync").length, 1);
});

test("a gap in the numbers resyncs the window", async () => {
  const { socket, clock, events } = await connected();
  socket.receive({ t: "ready", v: 1, seq: 0, resumed: false });
  socket.receive(event(1, { type: "approval-resolved", id: 1 }));
  socket.receive(event(3, { type: "approval-resolved", id: 3 }));
  await clock.advance(1);
  assert.deepEqual(
    events.map((e) => e.type),
    ["approval-resolved", "approval-resolved", "resync"],
  );
});

test("a pushed snapshot answers the window's next read without a call", async () => {
  const { socket, clock, events, bridge, calls } = await connected();
  socket.receive({ t: "ready", v: 1, seq: 7, resumed: false });
  socket.receive({
    t: "snapshot",
    seq: 12,
    snapshot: { conversations: [conversation("x")], platform: "linux" },
  });
  await clock.advance(1);
  assert.equal(events.at(-1)!.type, "resync");
  const before = calls.length;
  const snapshot = await bridge.api.snapshot();
  assert.equal(calls.length, before);
  assert.equal(snapshot.platform, "darwin");
  assert.deepEqual(snapshot.host, webHost);
  assert.equal(snapshot.conversations[0]!.id, "x");
  // Only once: the next read asks the runner.
  await bridge.api.snapshot();
  assert.equal(calls.length, before + 1);
});

test("a window that read its snapshot before the stream was up resyncs", async () => {
  const clock = new FakeClock();
  const { tab, bridge, events } = await signedInBridge(
    () => ({ conversations: [], platform: "linux" }),
    { clock },
  );
  await bridge.api.snapshot();
  const socket = tab.sockets.at(-1)!;
  socket.open();
  socket.receive({ t: "ready", v: 1, seq: 3, resumed: false });
  await clock.advance(150);
  assert.equal(events.filter((e) => e.type === "resync").length, 1);
});

test("the service signing the tab out returns it to the sign-in screen", async () => {
  const { socket, clock, tab, events, bridge } = await connected();
  socket.receive({ t: "ready", v: 1, seq: 0, resumed: false });
  socket.receive({
    t: "error",
    code: "password-changed",
    message: "Your password was changed on another device.",
  });
  socket.drop(4008);
  await flush();
  const signedOut = events.filter((e) => e.type === "signed-out") as Array<
    Extract<AppEvent, { type: "signed-out" }>
  >;
  assert.equal(signedOut.length, 1);
  assert.equal(signedOut[0]!.reason, "password-changed");
  assert.equal(
    signedOut[0]!.message,
    "Your password was changed on another device.",
  );
  assert.equal(bridge.auth.current, undefined);
  const count = tab.sockets.length;
  await clock.advance(reconnectMaxMs * 2);
  assert.equal(tab.sockets.length, count, "no reconnect after sign-out");
});

test("a signed-out event on the stream ends the session once", async () => {
  const { socket, events, bridge } = await connected();
  socket.receive({ t: "ready", v: 1, seq: 0, resumed: false });
  socket.receive(
    event(1, {
      type: "signed-out",
      reason: "revoked",
      message: "You signed out on all devices.",
    }),
  );
  await flush();
  assert.equal(events.filter((e) => e.type === "signed-out").length, 1);
  assert.equal(bridge.auth.current, undefined);
  assert.equal(socket.closedWith?.code, 1000);
});

test("a tab removed from the allow-list is signed out with the reason", async () => {
  const { socket, events } = await connected();
  socket.receive({
    t: "error",
    code: "CLAUDEX_WEB_NOT_ALLOWED",
    message: "Claudex on the web is in a private beta.",
  });
  socket.drop(4003);
  await flush();
  const signedOut = events.find((e) => e.type === "signed-out") as any;
  assert.equal(signedOut.message, "Claudex on the web is in a private beta.");
});

test("reconnects back off to 30 s, and faster after a stale ticket", async () => {
  const { socket, tab, clock } = await connected();
  socket.drop(4001);
  await clock.advance(250);
  assert.equal(tab.sockets.length, 2, "a stale ticket retries at once");
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    const current = tab.sockets.at(-1)!;
    current.drop(1006);
    await flush();
    delays.push(Math.min(...clock.pending()));
    await clock.advance(reconnectMaxMs);
  }
  assert.ok(delays[0]! < delays[3]!, `grows: ${delays}`);
  assert.ok(delays.every((d) => d <= reconnectMaxMs));
  assert.ok(delays.at(-1)! >= reconnectMaxMs * 0.8);
});

test("no capacity waits at least 5 s before trying again", async () => {
  const { socket, clock } = await connected();
  socket.receive({ t: "ready", v: 1, seq: 0, resumed: false });
  socket.drop(4503);
  await flush();
  assert.ok(Math.min(...clock.pending()) >= unavailableRetryMs);
});

test("pings keep the socket alive and a silent one is replaced", async () => {
  const { socket, tab, clock } = await connected();
  socket.receive({ t: "ready", v: 1, seq: 0, resumed: false });
  await clock.advance(25_000);
  assert.deepEqual(socket.frames().at(-1), { t: "ping" });
  await clock.advance(50_000);
  assert.equal(socket.closedWith?.code, 1000);
  await clock.advance(reconnectMaxMs);
  assert.equal(tab.sockets.length, 2);
});

test("visibility changes are reported as presence", async () => {
  const { socket, tab } = await connected();
  tab.visibility.forEach((listener) => listener(false, false));
  assert.deepEqual(socket.frames().at(-1), {
    t: "presence",
    visible: false,
    focused: false,
  });
});

test("payment pages open in this tab; new tabs are confirmed by the window", async () => {
  const { socket, tab, events } = await connected();
  socket.receive({
    t: "open-url",
    url: "/desktop-pay?order=7",
    target: "same-tab",
  });
  socket.receive({
    t: "open-url",
    url: "https://pay.example/checkout",
    target: "new-tab",
  });
  socket.receive({ t: "open-url", url: "//evil.example", target: "same-tab" });
  assert.deepEqual(tab.navigated, ["/desktop-pay?order=7"]);
  assert.deepEqual(events.at(-1), {
    type: "external-link",
    url: "https://pay.example/checkout",
  });
});

test("the conversation cache follows full and per-turn events", async () => {
  const { socket, bridge } = await connected();
  socket.receive({ t: "ready", v: 1, seq: 0, resumed: false });
  socket.receive(
    event(1, { type: "conversation", conversation: conversation("c") }),
  );
  socket.receive(
    event(2, {
      type: "conversation-turn",
      conversationId: "c",
      turn: { id: "t1", prompt: "hi", items: [] } as any,
      conversation: { title: "Renamed" },
    }),
  );
  const cached = bridge.state.conversation("c")!;
  assert.equal(cached.title, "Renamed");
  assert.equal(cached.turns.length, 1);
});

test("the window hears once when the stream goes down and once when it is back", async () => {
  const { socket, tab, clock, events } = await connected();
  const connection = () =>
    events
      .filter((e) => e.type === "stream-connection")
      .map((e) => (e as { connected: boolean }).connected);
  socket.receive({ t: "ready", v: 1, seq: 0, resumed: false });
  assert.deepEqual(connection(), []);
  socket.drop(1006);
  assert.deepEqual(connection(), [false]);
  // Failed attempts in between say nothing more.
  await clock.advance(reconnectMaxMs);
  tab.sockets.at(-1)!.drop(1006);
  assert.deepEqual(connection(), [false]);
  await clock.advance(reconnectMaxMs);
  const back = tab.sockets.at(-1)!;
  back.open();
  back.receive({ t: "ready", v: 1, seq: 0, resumed: true });
  assert.deepEqual(connection(), [false, true]);
});
