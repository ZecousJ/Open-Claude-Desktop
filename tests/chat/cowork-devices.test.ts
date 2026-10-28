import test from "node:test";
import assert from "node:assert/strict";
import { CoworkDevices } from "../../src-web/bridge/cowork-devices";
import {
  coworkComputerWaiting,
  devicePaths,
  type DeviceInfo,
} from "../../shared/remote-devices";
import type {
  AppEvent,
  Approval,
  Conversation,
  Snapshot,
  Turn,
} from "../../shared/types";

function setup(online = true, access = true) {
  const task = {
    id: "linked-task",
    title: "Task",
    mode: "cowork",
    turns: [],
    linkedToComputer: true,
    linkedComputerId: "pc-computer1",
    linkedComputerName: "My Mac",
    environment: { kind: "space", spaceId: "task-space" },
  } as unknown as Conversation;
  const local = {
    ...task,
    environment: { kind: "local" },
    turns: [{ id: "turn1", items: [], status: "inProgress" }],
  } as unknown as Conversation;
  let devices: DeviceInfo[] = [
    {
      id: "pc-computer1",
      name: "My Mac",
      online,
      computerAccess: access,
      platform: "darwin",
      version: "1",
      connectedAt: "now",
    },
  ];
  let approvals: Approval[] = [
    { id: 7, conversationId: task.id, method: "approval", params: {} },
  ];
  const calls: Array<{ path: string; args?: unknown[] }> = [];
  const events: AppEvent[] = [];
  const relay = new CoworkDevices(
    {
      json: async (path, init) => {
        const args = init?.body
          ? JSON.parse(String(init.body)).args
          : undefined;
        calls.push({ path, args });
        if (path.startsWith(devicePaths.list + "?"))
          return { ok: true, value: devices };
        if (path.endsWith("/openConversation"))
          return { ok: true, value: { conversation: local, approvals } };
        return { ok: true, value: null };
      },
    },
    (event) => events.push(event),
  );
  const snapshot = {
    conversations: [task],
    approvals: [],
    projects: [],
  } as unknown as Snapshot;
  const fallback = async () => {
    throw new Error("must not call the runner");
  };
  return {
    relay,
    task,
    local,
    calls,
    events,
    snapshot,
    fallback,
    setPresence: (online: boolean, computerAccess = true) => {
      devices = devices.map((device) => ({
        ...device,
        online,
        computerAccess,
      }));
    },
    resolve: () => {
      approvals = [];
    },
  };
}

test("web linked-task snapshot and send/interrupt/approvals use the owning device, not the runner", async () => {
  const h = setup();
  const snapshot = await h.relay.snapshot(h.snapshot);
  const task = snapshot.conversations[0];
  assert.equal(task.environment?.kind, "space");
  assert.equal(task.turns[0].status, "inProgress");
  assert.equal(coworkComputerWaiting(task), false);
  const sent = (await h.relay.route(
    "send",
    [{ conversationId: task.id, text: "Continue" }],
    h.fallback,
  )) as Conversation;
  assert.equal(sent.id, task.id);
  assert.equal(sent.environment?.kind, "space");
  await h.relay.route("interrupt", [task.id], h.fallback);
  await h.relay.route(
    "approve",
    [snapshot.approvals[0].id, { decision: "accept" }],
    h.fallback,
  );
  assert.deepEqual(
    h.calls.filter(
      (call) =>
        !call.path.endsWith("openConversation") &&
        !call.path.endsWith("listCodeConversations") &&
        call.args,
    ),
    [
      {
        path: devicePaths.rpc("pc-computer1", "send"),
        args: [{ conversationId: task.id, text: "Continue" }],
      },
      { path: devicePaths.rpc("pc-computer1", "interrupt"), args: [task.id] },
      {
        path: devicePaths.rpc("pc-computer1", "approve"),
        args: [7, { decision: "accept" }],
      },
    ],
  );
  h.resolve();
  await h.relay.refresh();
  assert.ok(
    h.events.some(
      (event) =>
        event.type === "approval-resolved" &&
        event.id === snapshot.approvals[0].id,
    ),
  );
});

test("offline or access-off computers block the composer and sending until reconnect", async () => {
  for (const [online, access] of [
    [false, true],
    [true, false],
  ]) {
    const h = setup(online, access);
    const snapshot = await h.relay.snapshot(h.snapshot);
    assert.equal(coworkComputerWaiting(snapshot.conversations[0]), true);
    await assert.rejects(
      h.relay.route(
        "send",
        [{ conversationId: h.task.id, text: "Continue" }],
        h.fallback,
      ),
      /Waiting for your computer/,
    );
    h.setPresence(true);
    await h.relay.refresh();
    const last = h.events
      .filter((event) => event.type === "conversation")
      .at(-1);
    assert.equal(
      last?.type === "conversation" && coworkComputerWaiting(last.conversation),
      false,
    );
    await h.relay.route(
      "send",
      [{ conversationId: h.task.id, text: "Continue" }],
      h.fallback,
    );
  }
});

test("device turn events preserve cloud identity and ignore another computer and stale cloud turns", async () => {
  const h = setup();
  await h.relay.snapshot(h.snapshot);
  const event = {
    type: "device-event",
    deviceId: "pc-computer1",
    event: {
      type: "conversation-turn",
      conversationId: h.task.id,
      turn: { id: "turn1", status: "completed", items: [] } as unknown as Turn,
      conversation: { environment: { kind: "local" } },
    },
  } as unknown as AppEvent;
  h.relay.event({ ...event, deviceId: "pc-foreign" } as unknown as AppEvent);
  assert.equal(h.events.length, 0);
  h.relay.event(event);
  const emitted = h.events[0];
  assert.equal(emitted.type, "conversation-turn");
  if (emitted.type === "conversation-turn")
    assert.equal(emitted.conversation?.environment?.kind, "space");
  assert.equal(
    h.relay.event({
      type: "conversation-turn",
      conversationId: h.task.id,
      turn: {} as Turn,
    }),
    true,
  );
  assert.equal(h.events.length, 1);
});

test("sign-out discards a pending presence refresh", async () => {
  const h = setup();
  await h.relay.snapshot(h.snapshot);
  const refresh = h.relay.refresh();
  h.relay.clear();
  await refresh;
  assert.equal(h.events.length, 0);
});

test("a computer's Remote Control Code sessions are listed on the web and open on that computer", async () => {
  const session = {
    id: "code-1",
    title: "做一个 helloworld 网页",
    mode: "code",
    cwd: "/Users/me/app",
    environment: { kind: "local" },
    turns: [{ id: "t1", items: [], status: "completed" }],
    updatedAt: 5,
  } as unknown as Conversation;
  const calls: string[] = [];
  const relay = new CoworkDevices(
    {
      json: async (path) => {
        calls.push(path);
        if (path.startsWith(devicePaths.list + "?"))
          return {
            ok: true,
            value: [
              {
                id: "pc-mac",
                name: "My Mac",
                online: true,
                platform: "darwin",
                version: "1",
                connectedAt: "now",
              },
            ],
          };
        if (path.endsWith("/listCodeConversations"))
          return {
            ok: true,
            value: [
              {
                id: "code-1",
                title: session.title,
                cwd: session.cwd,
                environment: session.environment,
                updatedAt: 5,
                running: false,
                approvals: 0,
                model: "gpt",
              },
            ],
          };
        if (path.endsWith("/openConversation"))
          return { ok: true, value: { conversation: session, approvals: [] } };
        if (path.endsWith("/send")) return { ok: true, value: null };
        if (path.endsWith("/listModels"))
          return {
            ok: true,
            value: { models: [{ providerId: "mac-provider", id: "other" }] },
          };
        return { ok: true, value: null };
      },
    },
    () => {},
  );
  const next = await relay.snapshot({
    conversations: [],
    approvals: [],
    projects: [],
  } as unknown as Snapshot);
  const listed = next.conversations.find((c) => c.id === "code-1")!;
  assert.equal(listed.mode, "code");
  assert.equal(listed.linkedComputerId, "pc-mac");
  assert.equal(listed.linkedComputerName, "My Mac");
  assert.equal(listed.slim, true);
  assert.ok(relay.owns("code-1"));
  const turns = (await relay.route("conversationTurns", ["code-1"], () =>
    Promise.reject(new Error("not routed")),
  )) as Pick<Conversation, "turns">;
  assert.equal(turns.turns.length, 1);
  await relay.route("send", [{ conversationId: "code-1", text: "hi" }], () =>
    Promise.reject(new Error("not routed")),
  );
  assert.ok(calls.some((path) => path.endsWith("/send")));
  // Its other changes never reach the service, which lacks it.
  const notRouted = () => Promise.reject(new Error("not routed"));
  const read = (await relay.route(
    "updateConversation",
    ["code-1", { unread: false }],
    notRouted,
  )) as Conversation;
  assert.equal(read.id, "code-1");
  await relay.route(
    "updateConversation",
    ["code-1", { providerId: "web-provider", model: "other" }],
    notRouted,
  );
  assert.ok(calls.some((path) => path.endsWith("/setModel")));
  const git = (await relay.route("codeGitStatus", ["code-1"], notRouted)) as {
    state: string;
  };
  assert.equal(git.state, "no-folder");
});
