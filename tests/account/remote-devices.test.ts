import test from "node:test";
import assert from "node:assert/strict";
import type { Approval, Conversation, Turn } from "../../shared/types";
import {
  DeviceMethods,
  type DeviceHost,
} from "../../electron/remote-control/device-methods";
import {
  DeviceLink,
  type LinkSocket,
} from "../../electron/remote-control/device-link";
import { deviceMethods, deviceWatchMs } from "../../shared/remote-devices";

const turn = (id: string, status: Turn["status"] = "completed") =>
  ({ id, status, items: [] }) as unknown as Turn;

const conversation = (id: string, part: Partial<Conversation> = {}) =>
  ({
    id,
    title: id,
    mode: "code",
    cwd: "/work",
    providerId: "p1",
    model: "gpt-5.5",
    archived: false,
    updatedAt: 1,
    turns: [turn(`${id}-t1`)],
    ...part,
  }) as unknown as Conversation;

function host(
  conversations: Conversation[],
  approvals: Approval[] = [],
  folders: string[] = [],
) {
  let now = 1000;
  const calls: Array<[string, unknown[]]> = [];
  const h: DeviceHost & { advance(ms: number): void; calls: typeof calls } = {
    conversations: () => conversations,
    approvals: () => approvals,
    send: async (input) => {
      calls.push(["send", [input]]);
      return input.conversationId ? conversations[0] : { id: "fresh" };
    },
    interrupt: async (id) => {
      calls.push(["interrupt", [id]]);
    },
    approve: async (id, result) => {
      calls.push(["approve", [id, result]]);
    },
    remoteFolders: () => folders,
    models: () => ({
      models: [
        { providerId: "p1", id: "gpt-5.5" },
        { providerId: "p1", id: "gpt-5.5-mini" },
      ],
      default: { providerId: "p1", id: "gpt-5.5" },
    }),
    update: async (id, patch) => {
      calls.push(["update", [id, patch]]);
    },
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    calls,
  };
  return h;
}

test("remote capacity counts live work and reserves simultaneous starts, not historical sessions", async () => {
  const h = host(
    Array.from({ length: 100 }, (_, index) => conversation(`done-${index}`)),
    [],
    ["/work"],
  );
  const methods = new DeviceMethods(h);
  assert.deepEqual(await methods.call("remoteControlCapacity", []), {
    active: 0,
    max: 32,
  });
  let finish!: (value: unknown) => void;
  h.send = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = methods.call("newSession", [{ cwd: "/work", text: "hello" }]);
  assert.deepEqual(await methods.call("remoteControlCapacity", []), {
    active: 1,
    max: 32,
  });
  finish({ id: "fresh" });
  await pending;
  assert.equal(methods.capacity().active, 0);
  const full = new DeviceMethods(
    host(
      Array.from({ length: 32 }, (_, index) =>
        conversation(`busy-${index}`, {
          turns: [turn(`turn-${index}`, "inProgress")],
        }),
      ),
      [],
      ["/work"],
    ),
  );
  await assert.rejects(
    full.call("newSession", [{ cwd: "/work", text: "hello" }]),
    /at capacity/,
  );
});

test("remote starts store transferred attachment bytes on the destination and reject malformed transfers", async () => {
  const h = host([], [], ["/work"]);
  const file = {
    id: "file",
    name: "note.txt",
    kind: "text" as const,
    path: "/stored/note.txt",
    size: 5,
  };
  h.addAttachment = async (name, data) => {
    assert.equal(name, "note.txt");
    assert.equal(Buffer.from(data).toString(), "hello");
    return file;
  };
  const methods = new DeviceMethods(h);
  await methods.call("newSession", [
    {
      cwd: "/work",
      text: "read it",
      attachments: [{ name: "note.txt", data: "aGVsbG8=" }],
    },
  ]);
  assert.deepEqual(
    (h.calls[0][1][0] as { attachments: unknown[] }).attachments,
    [file],
  );
  await assert.rejects(
    methods.call("newSession", [
      {
        cwd: "/work",
        text: "read it",
        attachments: [{ name: "note.txt", data: "not base64" }],
      },
    ]),
    /can't be attached/,
  );
  assert.equal(methods.capacity().active, 0);
});

test("a session opted out of Remote Control cannot be opened or continued remotely", async () => {
  const methods = new DeviceMethods(
    host([conversation("private", { remoteControlOff: true })]),
  );
  assert.deepEqual(await methods.call("listCodeConversations", []), []);
  await assert.rejects(
    methods.call("openConversation", ["private"]),
    /not on this computer/,
  );
  await assert.rejects(
    methods.call("send", [{ conversationId: "private", text: "hello" }]),
    /not on this computer/,
  );
});

test("Code lists stay Code-only; Dispatch can also reach this computer's Cowork tasks", async () => {
  const h = host(
    [
      conversation("code-1", { updatedAt: 5 }),
      conversation("code-ssh", {
        updatedAt: 9,
        environment: { kind: "ssh", hostId: "box" },
      }),
      conversation("chat-1", { mode: "chat" }),
      conversation("cowork-1", { mode: "cowork" }),
      conversation("secret", { incognito: true }),
      conversation("cloud", { environment: { kind: "space", spaceId: "r-1" } }),
      conversation("old", { archived: true }),
      conversation("busy", { updatedAt: 7, turns: [turn("b1", "inProgress")] }),
    ],
    [
      {
        id: 7,
        conversationId: "busy",
        method: "item/commandExecution/requestApproval",
        params: {},
      },
    ],
  );
  const m = new DeviceMethods(h);
  const list = (await m.call("listCodeConversations", [])) as Array<{
    id: string;
    running: boolean;
    approvals: number;
  }>;
  assert.deepEqual(
    list.map((c) => c.id),
    ["code-ssh", "busy", "code-1"],
  );
  assert.equal(list[1]!.running, true);
  assert.equal(list[1]!.approvals, 1);
  const dispatch = (await m.call("listDispatchTasks", [])) as Array<{
    id: string;
  }>;
  assert.ok(dispatch.some((item) => item.id === "cowork-1"));
  const cowork = (await m.call("openConversation", ["cowork-1"])) as {
    conversation: Conversation;
  };
  assert.equal(cowork.conversation.mode, "cowork");
  for (const id of ["chat-1", "secret", "cloud", "nope"])
    await assert.rejects(
      m.call("openConversation", [id]),
      /not on this computer/,
    );
  await assert.rejects(
    m.call("deleteConversation", ["code-1"]),
    /can't do that/,
  );
});

test("send continues the conversation with its own model; open streams it for a while", async () => {
  const h = host([conversation("code-1")]);
  const m = new DeviceMethods(h);
  const opened = (await m.call("openConversation", ["code-1"])) as {
    conversation: Conversation;
  };
  assert.equal(opened.conversation.id, "code-1");
  assert.equal(m.isWatched("code-1"), true);
  await m.call("send", [{ conversationId: "code-1", text: "run the tests" }]);
  assert.deepEqual(h.calls[0], [
    "send",
    [
      {
        conversationId: "code-1",
        text: "run the tests",
        mode: "code",
        attachments: [],
        providerId: "p1",
        model: "gpt-5.5",
      },
    ],
  ]);
  await assert.rejects(
    m.call("send", [{ conversationId: "code-1", text: "  " }]),
    /Write a message/,
  );
  h.advance(deviceWatchMs + 1);
  assert.equal(m.isWatched("code-1"), false);
  // Not watched: a change only says the list changed.
  assert.deepEqual(
    m
      .eventsFor({ type: "conversation", conversation: conversation("code-1") })
      .map((e) => e.type),
    ["device-conversations"],
  );
  await m.call("openConversation", ["code-1"]);
  assert.deepEqual(
    m
      .eventsFor({ type: "conversation", conversation: conversation("code-1") })
      .map((e) => e.type),
    ["device-conversations", "conversation"],
  );
  assert.deepEqual(
    m.eventsFor({
      type: "conversation",
      conversation: conversation("c", { mode: "chat" }),
    }),
    [],
  );
});

test("approvals: only a waiting one of a reachable conversation", async () => {
  const approvals: Approval[] = [
    {
      id: 1,
      conversationId: "code-1",
      method: "item/fileChange/requestApproval",
      params: {},
    },
    {
      id: 2,
      conversationId: "chat-1",
      method: "item/fileChange/requestApproval",
      params: {},
    },
  ];
  const h = host(
    [conversation("code-1"), conversation("chat-1", { mode: "chat" })],
    approvals,
  );
  const m = new DeviceMethods(h);
  await m.call("approve", [1, { decision: "accept" }]);
  assert.deepEqual(h.calls.at(-1), ["approve", [1, { decision: "accept" }]]);
  await assert.rejects(
    m.call("approve", [2, { decision: "accept" }]),
    /not on this computer/,
  );
  await assert.rejects(
    m.call("approve", [3, { decision: "accept" }]),
    /already answered/,
  );
  assert.deepEqual(
    m
      .eventsFor({ type: "approval", approval: approvals[0]! })
      .map((e) => e.type),
    ["approval", "device-conversations"],
  );
  assert.deepEqual(
    m.eventsFor({ type: "approval", approval: approvals[1]! }),
    [],
  );
  await m.call("interrupt", ["code-1"]);
  assert.deepEqual(h.calls.at(-1), ["interrupt", ["code-1"]]);
});

test("linked Cowork tasks relay messages, stops and approvals independently of Code remote control", async () => {
  const task = conversation("linked", {
    mode: "cowork",
    linkedToComputer: true,
  });
  const approval: Approval = {
    id: 4,
    conversationId: task.id,
    method: "approval",
    params: {},
  };
  const h = host([task, conversation("code")], [approval]);
  h.codeEnabled = () => false;
  h.computerAccess = () => true;
  const methods = new DeviceMethods(h);
  await methods.call("openConversation", [task.id]);
  await methods.call("send", [{ conversationId: task.id, text: "Continue" }]);
  assert.equal((h.calls[0][1][0] as any).mode, "cowork");
  await methods.call("interrupt", [task.id]);
  await methods.call("approve", [4, { decision: "accept" }]);
  assert.deepEqual(h.calls.slice(1), [
    ["interrupt", [task.id]],
    ["approve", [4, { decision: "accept" }]],
  ]);
  assert.equal(
    methods.eventsFor({ type: "conversation", conversation: task }).length,
    2,
  );
  assert.deepEqual(methods.summaries(), []);
  await assert.rejects(
    methods.call("openConversation", ["code"]),
    /not on this computer/,
  );
  for (const method of [
    "newSession",
    "listDirectories",
    "listModels",
    "setModel",
    "endSession",
  ])
    await assert.rejects(methods.call(method, []), /can't do that/);
  assert.deepEqual(
    methods.eventsFor({
      type: "conversation",
      conversation: conversation("code"),
    }),
    [],
  );
  h.computerAccess = () => false;
  await assert.rejects(
    methods.call("send", [{ conversationId: task.id, text: "Continue" }]),
    /Waiting for your computer/,
  );
  await methods.call("interrupt", [task.id]);
});

class FakeSocket implements LinkSocket {
  readyState = 0;
  sent: Array<Record<string, any>> = [];
  closed?: { code?: number; reason?: string };
  onopen: LinkSocket["onopen"] = null;
  onmessage: LinkSocket["onmessage"] = null;
  onclose: LinkSocket["onclose"] = null;
  onerror: LinkSocket["onerror"] = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  of(t: string) {
    return this.sent.filter((f) => f.t === t);
  }
}

function linkSetup(
  conversations: Conversation[],
  extra: Partial<ConstructorParameters<typeof DeviceLink>[0]> = {},
) {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ at: number; cb: () => void; id: number }> = [];
  let now = 0;
  let nextId = 0;
  let enabled = true;
  const tickets: unknown[] = [];
  let computerAccess = true;
  const h = host(conversations);
  const methods = new DeviceMethods(h);
  const link = new DeviceLink({
    computerAccess: () => computerAccess,
    baseUrl: () => "https://claudex.example",
    session: () => ({
      currentToken: async () => "tok",
      renewed: async () => "tok2",
    }),
    enabled: () => enabled,
    linkId: () => "pc-0123456789",
    name: () => "Studio",
    platform: "darwin",
    version: "0.0.9",
    methods,
    fetch: (async (url: URL, init: RequestInit) => {
      tickets.push({
        url: String(url),
        body: init.body,
        headers: init.headers,
      });
      return new Response(
        JSON.stringify({
          code: 0,
          data: { ticket: "A".repeat(43), expires_in: 30 },
        }),
        { status: 200 },
      );
    }) as typeof fetch,
    openSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    setTimeout: (cb, ms) => {
      const id = ++nextId;
      timers.push({ at: now + ms, cb, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    now: () => now,
    ...extra,
  });
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > now) break;
      timers.shift();
      due.cb();
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    link,
    sockets,
    tickets,
    advance,
    settle,
    setEnabled: (v: boolean) => (enabled = v),
    setComputerAccess: (v: boolean) => (computerAccess = v),
    h,
  };
}

test("the relay exposes network and sign-in causes and clears them once reconnected", async () => {
  const setup = linkSetup([]);
  setup.link.refresh();
  await setup.settle();
  await setup.settle();
  let socket = setup.sockets[0];
  socket.open();
  socket.receive({ t: "welcome" });
  assert.equal(setup.link.status().cause, undefined);
  socket.onclose?.({ code: 1006, reason: "network" });
  assert.equal(setup.link.status().cause, "network");
  setup.advance(3000);
  await setup.settle();
  await setup.settle();
  socket = setup.sockets.at(-1)!;
  assert.equal(setup.sockets.length, 2);
  socket.open();
  socket.receive({ t: "welcome" });
  assert.equal(setup.link.status().cause, undefined);
  socket.onclose?.({ code: 4008, reason: "" });
  assert.equal(setup.link.status().cause, "sign_in");
  setup.link.disconnect();
});

test("the link says hello with its methods, answers calls and relays errors", async () => {
  const s = linkSetup([conversation("code-1")]);
  s.link.refresh();
  await s.settle();
  await s.settle();
  assert.equal(s.sockets.length, 1);
  const socket = s.sockets[0]!;
  assert.equal(
    socket.url,
    "wss://claudex.example/api/v1/claudex/web/device/link",
  );
  assert.deepEqual(socket.protocols, [
    "claudex.v1",
    `ticket.${"A".repeat(43)}`,
  ]);
  assert.match(
    String((s.tickets[0] as { url: string }).url),
    /\/api\/v1\/claudex\/web\/auth\/events-ticket$/,
  );
  assert.equal(
    JSON.parse(String((s.tickets[0] as { body: string }).body)).tabId,
    "pc-0123456789",
  );
  socket.open();
  const hello = socket.of("hello")[0]!;
  assert.equal(hello.deviceId, "pc-0123456789");
  assert.equal(hello.name, "Studio");
  assert.equal(hello.computerAccess, true);
  assert.deepEqual(hello.methods, [...deviceMethods]);
  socket.receive({ t: "welcome", v: 1, heartbeatMs: 1000 });
  assert.equal(s.link.connected, true);
  s.setComputerAccess(false);
  s.link.refresh();
  assert.deepEqual(socket.of("status"), [
    { t: "status", computerAccess: false },
  ]);

  socket.receive({
    t: "call",
    id: "d1",
    method: "listCodeConversations",
    args: [],
  });
  socket.receive({
    t: "call",
    id: "d2",
    method: "openConversation",
    args: ["chat-x"],
  });
  await s.settle();
  const results = socket.of("result");
  assert.equal(results[0]!.id, "d1");
  assert.equal(results[0]!.ok, true);
  assert.equal(results[0]!.value[0].id, "code-1");
  assert.equal(results[1]!.ok, false);
  assert.match(results[1]!.error.message, /not on this computer/);

  // Heartbeat.
  s.advance(1000);
  assert.equal(socket.of("ping").length, 1);
  socket.receive({ t: "pong" });

  // Switched off: closed and not dialled again.
  s.setEnabled(false);
  s.link.refresh();
  assert.ok(socket.closed);
  s.advance(120_000);
  await s.settle();
  assert.equal(s.sockets.length, 1);
});

test("a running reply's changes are merged, sent as its last turn, and the list hint is throttled", async () => {
  const c = conversation("code-1", {
    turns: [turn("t1"), turn("t2", "inProgress")],
  });
  const s = linkSetup([c]);
  s.link.refresh();
  await s.settle();
  await s.settle();
  const socket = s.sockets[0]!;
  socket.open();
  socket.receive({ t: "welcome", v: 1, heartbeatMs: 25_000 });
  socket.receive({
    t: "call",
    id: "d1",
    method: "openConversation",
    args: ["code-1"],
  });
  await s.settle();

  for (let i = 0; i < 5; i++)
    s.link.observe({
      type: "conversation",
      conversation: { ...c, title: `v${i}` },
    });
  const events = () => socket.of("event").map((f) => f.event);
  assert.deepEqual(
    events().map((e) => e.type),
    ["device-conversations"],
  );
  s.advance(250);
  const turnEvents = events().filter((e) => e.type === "conversation-turn");
  assert.equal(turnEvents.length, 1);
  assert.equal(turnEvents[0].turn.id, "t2");
  assert.equal(turnEvents[0].conversation.title, "v4");
  assert.equal(turnEvents[0].conversation.turns, undefined);
  s.advance(1500);
  assert.equal(
    events().filter((e) => e.type === "device-conversations").length,
    2,
  );

  // A turn before the last changed (an edit): the whole conversation.
  s.link.observe({
    type: "conversation",
    conversation: { ...c, turns: [turn("t1b"), turn("t2")] },
  });
  s.advance(250);
  assert.equal(events().filter((e) => e.type === "conversation").length, 1);
});

test("the link dials again after a drop, at once after a renew", async () => {
  const s = linkSetup([]);
  s.link.refresh();
  await s.settle();
  await s.settle();
  const first = s.sockets[0]!;
  first.open();
  first.receive({ t: "welcome", v: 1, heartbeatMs: 25_000 });
  first.onclose?.({ code: 1000, reason: "renew" });
  assert.equal(s.link.connected, false);
  s.advance(300);
  await s.settle();
  await s.settle();
  assert.equal(s.sockets.length, 2);
  const second = s.sockets[1]!;
  second.open();
  // Silence for 2.5 heartbeats: dropped and dialled again later.
  s.advance(25_000 * 2.5);
  assert.ok(second.closed);
  s.advance(3000);
  await s.settle();
  await s.settle();
  assert.equal(s.sockets.length, 3);
});

test("a link taken by another computer with the same id links again under a new id", async () => {
  let id = "pc-copied000";
  const s = linkSetup([], {
    linkId: () => id,
    renewLinkId: () => {
      id = "pc-fresh00000";
    },
  });
  s.link.refresh();
  await s.settle();
  await s.settle();
  const first = s.sockets[0]!;
  first.open();
  first.receive({ t: "welcome", v: 1, heartbeatMs: 25_000 });
  first.onclose?.({ code: 4409, reason: "replaced" });
  assert.equal(s.link.status().cause, undefined);
  s.advance(1200);
  await s.settle();
  await s.settle();
  assert.equal(s.sockets.length, 2);
  s.sockets[1]!.open();
  assert.equal(s.sockets[1]!.sent[0]?.deviceId, "pc-fresh00000");
});

test("a phone starts sessions only in the folders added for it", async () => {
  const h = host(
    [
      conversation("a", { cwd: "/work/app" }),
      conversation("b", { cwd: "/work/app", archived: true }),
    ],
    [],
    ["/work/app", "/work/site", "/", "relative/dir"],
  );
  const m = new DeviceMethods(h);
  assert.deepEqual(await m.call("listDirectories", []), [
    { path: "/work/app", name: "app", sessions: 1, default: true },
    { path: "/work/site", name: "site", sessions: 0, default: false },
  ]);
  const made = await m.call("newSession", [
    { cwd: "/work/site", text: "build it" },
  ]);
  assert.deepEqual(made, { conversationId: "fresh" });
  assert.deepEqual(h.calls.at(-1), [
    "send",
    [
      {
        cwd: "/work/site",
        text: "build it",
        mode: "code",
        attachments: [],
        providerId: "p1",
        model: "gpt-5.5",
      },
    ],
  ]);
  assert.equal(m.isWatched("fresh"), true);
  await m.call("newSession", [
    { cwd: "/work/app", text: "x", providerId: "p1", model: "gpt-5.5-mini" },
  ]);
  assert.equal(
    (h.calls.at(-1)![1][0] as { model: string }).model,
    "gpt-5.5-mini",
  );
  const before = h.calls.length;
  for (const cwd of ["/etc", "/work/app/../../etc", "/", "relative/dir", "", 7])
    await assert.rejects(m.call("newSession", [{ cwd, text: "x" }]));
  await assert.rejects(
    m.call("newSession", [{ cwd: "/work/app", text: " " }]),
    /Write a message/,
  );
  await assert.rejects(
    m.call("newSession", [
      { cwd: "/work/app", text: "x", providerId: "p1", model: "nope" },
    ]),
    /cannot use/,
  );
  assert.equal(h.calls.length, before);
});

test("ending a session stops a running turn and archives it", async () => {
  const h = host([
    conversation("busy", { turns: [turn("b1", "inProgress")] }),
    conversation("idle"),
    conversation("chat", { mode: "chat" }),
  ]);
  const m = new DeviceMethods(h);
  await m.call("openConversation", ["busy"]);
  await m.call("endSession", ["busy"]);
  assert.deepEqual(h.calls.slice(-2), [
    ["interrupt", ["busy"]],
    ["update", ["busy", { archived: true }]],
  ]);
  assert.equal(m.isWatched("busy"), false);
  await m.call("endSession", ["idle"]);
  assert.deepEqual(h.calls.at(-1), ["update", ["idle", { archived: true }]]);
  assert.equal(h.calls.filter((c) => c[0] === "interrupt").length, 1);
  await assert.rejects(m.call("endSession", ["chat"]), /not on this computer/);
});

test("setModel changes the session's model to one the computer offers", async () => {
  const h = host([conversation("code-1")]);
  const m = new DeviceMethods(h);
  const listed = (await m.call("listModels", [])) as { models: unknown[] };
  assert.equal(listed.models.length, 2);
  await m.call("setModel", [
    { conversationId: "code-1", providerId: "p1", model: "gpt-5.5-mini" },
  ]);
  assert.deepEqual(h.calls.at(-1), [
    "update",
    ["code-1", { providerId: "p1", model: "gpt-5.5-mini" }],
  ]);
  await assert.rejects(
    m.call("setModel", [
      { conversationId: "code-1", providerId: "p9", model: "gpt-5.5" },
    ]),
    /cannot use/,
  );
  await assert.rejects(
    m.call("setModel", [{ conversationId: "code-1" }]),
    /Choose a model/,
  );
  await assert.rejects(
    m.call("setModel", [
      { conversationId: "nope", providerId: "p1", model: "gpt-5.5" },
    ]),
    /not on this computer/,
  );
});
