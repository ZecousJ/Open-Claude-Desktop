/**
 * R9-S3: messages that wait for an SSH host (electron/ssh/outbox.ts) and
 * the engine's exactly-once delivery. The engine's Codex connection and
 * launcher are stand-ins here; tests/ssh/ssh-launcher.test.ts runs the
 * whole path against the real app-server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPolicy } from "../../shared/client-policy";
import type { Conversation, Turn } from "../../shared/types";
import { Engine } from "../../electron/engine/engine";
import { type EngineLauncher } from "../../electron/engine/engine-types";
import { Store } from "../../electron/store/store";
import {
  MAX_OUTBOX_ENTRIES,
  OUTBOX_FILE,
  Outbox,
  deliveredIn,
  isOutboxTurn,
  newOutboxId,
  type OutboxEntry,
} from "../../electron/ssh/outbox";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cx-outbox-"));

function entry(patch: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: newOutboxId(),
    conversationId: "c1",
    hostId: "h1",
    text: "hello",
    attachments: [],
    mode: "code",
    providerId: "p",
    model: "m",
    createdAt: 1,
    ...patch,
  };
}

test("the outbox keeps its messages in the profile, one per conversation", () => {
  const root = temp();
  try {
    const box = new Outbox(root);
    const a = entry();
    box.put(a);
    assert.equal(
      (fs.statSync(path.join(root, OUTBOX_FILE)).mode & 0o777).toString(8),
      "600",
    );
    assert.throws(() => box.put(entry()), /already waiting/);
    box.put(entry({ conversationId: "c2", hostId: "h2" }));
    assert.equal(box.list("h1").length, 1);
    assert.equal(box.list().length, 2);
    assert.equal(box.forConversation("c1")?.id, a.id);
    box.markAttempted(a.id);
    // Across a restart, with a damaged entry dropped on its own.
    const raw = JSON.parse(fs.readFileSync(box.file, "utf8"));
    raw.push({ id: "outbox-x", conversationId: 5 });
    raw.push({ ...a, id: newOutboxId(), hostId: "-oProxyCommand=x y" });
    fs.writeFileSync(box.file, JSON.stringify(raw));
    const again = new Outbox(root);
    assert.equal(again.list().length, 2);
    assert.equal(again.get(a.id)?.attempted, true);
    // Returned copies can't change what is stored.
    again.list()[0].text = "changed";
    assert.equal(again.get(a.id)?.text, "hello");
    again.prune((value) => value.conversationId !== "c2");
    assert.equal(again.list().length, 1);
    again.remove(a.id);
    assert.equal(fs.existsSync(again.file), false);
    assert.throws(() => again.put({ ...a, id: "bad" }), /can't wait/);
    for (let i = 0; i < MAX_OUTBOX_ENTRIES; i++)
      again.put(entry({ conversationId: `c-${i}` }));
    assert.throws(() => again.put(entry({ conversationId: "x" })), /Too many/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a message counts as delivered only when the thread holds its id", () => {
  const id = newOutboxId();
  const thread = {
    turns: [
      {
        id: "t1",
        status: "completed",
        items: [{ type: "userMessage", clientId: "other" }],
      },
      {
        id: "t2",
        status: "failed",
        items: [
          { type: "agentMessage", clientId: id },
          { type: "userMessage", clientId: id },
        ],
      },
    ],
  };
  assert.deepEqual(deliveredIn(thread, id), { turnId: "t2", status: "failed" });
  assert.equal(deliveredIn(thread, newOutboxId()), undefined);
  assert.equal(deliveredIn(undefined, id), undefined);
  assert.equal(deliveredIn({ turns: "x" }, id), undefined);
});

// --------------------------------------------------------- the engine

type Call = { method: string; params: any };

function setup() {
  const root = temp();
  const store = new Store(root);
  store.settings.providers = [
    {
      id: "p",
      name: "Fixture",
      protocol: "responses",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      models: ["m"],
    },
  ];
  store.settings.activeProviderId = "p";
  const local = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  local.policy = () => openPolicy;
  const outbox = new Outbox(root);
  let waiting = false;
  const launcher: EngineLauncher = {
    environment: { kind: "ssh", hostId: "h1" },
    label: "box",
    platform: "linux",
    waiting: () => waiting,
    launch: async () => {
      throw new Error("not used");
    },
    started() {},
    exited() {},
    failed() {},
    dispose: async () => {},
  };
  const remote = local.createPeer({
    environment: { kind: "ssh", hostId: "h1" },
    launcher,
    outbox,
  });
  const calls: Call[] = [];
  const rpc = {
    connected: true,
    read: undefined as unknown,
    dropOnTurnStart: false,
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "thread/read") return { thread: rpc.read };
      if (method === "turn/start") {
        if (rpc.dropOnTurnStart) {
          rpc.connected = false;
          throw new Error("The Codex process exited (255)");
        }
        return { turn: { id: `turn-${calls.length}` } };
      }
      return {};
    },
  };
  let ensureError: Error | undefined;
  remote.ensure = async () => {
    if (ensureError) throw ensureError;
    remote.rpc = rpc as any;
  };
  const input = (patch: Record<string, unknown> = {}) => ({
    text: "hello",
    mode: "code" as const,
    cwd: "/srv/app",
    attachments: [],
    providerId: "p",
    model: "m",
    environment: { kind: "ssh" as const, hostId: "h1" },
    ...patch,
  });
  return {
    root,
    store,
    local,
    remote,
    outbox,
    calls,
    rpc,
    input,
    setWaiting: (value: boolean) => (waiting = value),
    setDefaultCwd: (home?: string) => {
      launcher.defaultCwd = home ? async () => home : undefined;
    },
    setEnsureError: (error?: Error) => (ensureError = error),
    turnStarts: () => calls.filter((c) => c.method === "turn/start"),
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const transientError = () =>
  Object.assign(new Error("Reconnecting to box…"), { transient: true });

test("while the host reconnects a message waits as its own turn, without blocking anything", async () => {
  const env = setup();
  try {
    env.setWaiting(true);
    const c = await env.remote.send(env.input());
    assert.deepEqual(c.environment, { kind: "ssh", hostId: "h1" });
    assert.equal(c.cwd, "/srv/app");
    const waiting = c.turns.at(-1)!;
    assert.ok(isOutboxTurn(waiting));
    assert.equal(waiting.status, "inProgress");
    assert.equal(waiting.reconnecting, "Will send when box reconnects");
    assert.equal(env.outbox.forConversation(c.id)?.id, waiting.id);
    assert.equal(env.calls.length, 0);
    assert.equal(env.remote.isBusy(), false);
    assert.equal(env.local.isBusy(), false);
    // One waits per conversation.
    await assert.rejects(
      env.remote.send(env.input({ conversationId: c.id })),
      /already waiting/,
    );
    // Stop: it is never sent.
    await env.remote.interrupt(c.id);
    const stopped = env.store.conversation(c.id).turns.at(-1)!;
    assert.equal(stopped.status, "interrupted");
    assert.equal(stopped.reconnecting, undefined);
    assert.equal(env.outbox.list().length, 0);
  } finally {
    env.close();
  }
});

test("a host that is reconnecting by itself makes a message wait; other failures don't", async () => {
  const env = setup();
  try {
    env.setEnsureError(transientError());
    const c = await env.remote.send(env.input());
    assert.ok(isOutboxTurn(c.turns.at(-1)));
    env.setEnsureError(new Error("Couldn't sign in to box."));
    await assert.rejects(
      env.remote.send(env.input({ text: "other" })),
      /Couldn't sign in/,
    );
    assert.equal(env.outbox.list().length, 1);
    // An SSH conversation needs a folder on the host.
    await assert.rejects(
      env.remote.send(env.input({ cwd: undefined })),
      /Choose a folder on box/,
    );
  } finally {
    env.close();
  }
});

// A message sent without a folder runs in the host's default folder or the
// user's home there.
test("an SSH message without a folder runs in the host's home", async () => {
  const env = setup();
  try {
    env.setDefaultCwd("/home/ubuntu");
    const c = await env.remote.send(env.input({ cwd: undefined }));
    assert.equal(c.cwd, "/home/ubuntu");
    const start = env.calls.find((call) => call.method === "thread/start");
    assert.equal(start?.params.cwd, "/home/ubuntu");
  } finally {
    env.close();
  }
});

test("a waiting message is sent once when the host is back", async () => {
  const env = setup();
  try {
    env.setWaiting(true);
    const c = await env.remote.send(env.input({ text: "later" }));
    const id = c.turns.at(-1)!.id;
    env.setWaiting(false);
    await env.remote.deliverOutbox();
    const starts = env.turnStarts();
    assert.equal(starts.length, 1);
    assert.equal(starts[0].params.clientUserMessageId, id);
    assert.equal(starts[0].params.input[0].text, "later");
    const turns = env.store.conversation(c.id).turns;
    assert.equal(turns.length, 1);
    assert.equal(turns[0].prompt, "later");
    assert.ok(!isOutboxTurn(turns[0]));
    assert.equal(turns[0].status, "inProgress");
    assert.equal(env.outbox.list().length, 0);
    // Delivering again sends nothing.
    await env.remote.deliverOutbox();
    assert.equal(env.turnStarts().length, 1);
  } finally {
    env.close();
  }
});

test("a message whose turn/start may have arrived is checked in the thread first", async () => {
  const env = setup();
  try {
    // The first message runs, so the conversation has a thread.
    const c = await env.remote.send(env.input({ text: "first" }));
    const first = env.store.conversation(c.id).turns.at(-1)!;
    first.status = "completed";
    // The connection drops while the next message is on its way.
    env.rpc.dropOnTurnStart = true;
    const after = await env.remote.send(
      env.input({ conversationId: c.id, text: "second" }),
    );
    const waiting = after.turns.at(-1)!;
    assert.ok(isOutboxTurn(waiting));
    assert.equal(waiting.prompt, "second");
    assert.equal(env.outbox.get(waiting.id)?.attempted, true);
    assert.equal(after.turns.filter((t) => t.prompt === "second").length, 1);

    // Back: the host did receive it, so it is not sent again.
    env.rpc.dropOnTurnStart = false;
    env.rpc.connected = true;
    env.rpc.read = {
      turns: [
        {
          id: "remote-turn",
          status: "interrupted",
          items: [{ type: "userMessage", clientId: waiting.id }],
        },
      ],
    };
    const startsBefore = env.turnStarts().length;
    await env.remote.deliverOutbox();
    assert.equal(env.turnStarts().length, startsBefore);
    const turn = env.store
      .conversation(c.id)
      .turns.find((t) => t.prompt === "second")!;
    assert.equal(turn.id, "remote-turn");
    assert.equal(turn.status, "failed");
    assert.match(turn.error!, /connection to box dropped/);
    assert.equal(env.outbox.list().length, 0);
  } finally {
    env.close();
  }
});

test("a message the host never received is sent after the check", async () => {
  const env = setup();
  try {
    const c = await env.remote.send(env.input({ text: "first" }));
    env.store.conversation(c.id).turns.at(-1)!.status = "completed";
    env.rpc.dropOnTurnStart = true;
    const after = await env.remote.send(
      env.input({ conversationId: c.id, text: "second" }),
    );
    const id = after.turns.at(-1)!.id;
    env.rpc.dropOnTurnStart = false;
    env.rpc.connected = true;
    env.rpc.read = { turns: [{ id: "t", items: [{ type: "userMessage" }] }] };
    await env.remote.deliverOutbox();
    const reads = env.calls.filter((call) => call.method === "thread/read");
    assert.equal(reads.length, 1);
    assert.equal(reads[0].params.includeTurns, true);
    const resent = env
      .turnStarts()
      .filter((call) => call.params.clientUserMessageId === id);
    // The dropped attempt and the one after the check.
    assert.equal(resent.length, 2);
    const turns = env.store.conversation(c.id).turns;
    assert.equal(turns.filter((t) => t.prompt === "second").length, 1);
    assert.equal(env.outbox.list().length, 0);
  } finally {
    env.close();
  }
});

test("delivery keeps waiting while the host is still away and drops what no longer exists", async () => {
  const env = setup();
  try {
    env.setWaiting(true);
    const c = await env.remote.send(env.input({ text: "later" }));
    env.setWaiting(false);
    env.setEnsureError(transientError());
    await env.remote.deliverOutbox();
    assert.equal(env.outbox.list().length, 1);
    assert.ok(isOutboxTurn(env.store.conversation(c.id).turns.at(-1)));
    // The conversation is deleted: its message goes too.
    env.store.conversations = env.store.conversations.filter(
      (value: Conversation) => value.id !== c.id,
    );
    env.setEnsureError(undefined);
    await env.remote.deliverOutbox();
    assert.equal(env.outbox.list().length, 0);
    assert.equal(env.turnStarts().length, 0);
  } finally {
    env.close();
  }
});

test("a waiting message the host refuses shows the error on its turn", async () => {
  const env = setup();
  try {
    env.setWaiting(true);
    const c = await env.remote.send(env.input({ text: "later" }));
    env.setWaiting(false);
    // The model was removed from the account meanwhile.
    env.store.settings.providers[0].models = ["other"];
    env.store.settings.providers[0].model = "other";
    await env.remote.deliverOutbox();
    const turn: Turn = env.store.conversation(c.id).turns.at(-1)!;
    assert.equal(turn.status, "failed");
    assert.match(turn.error!, /can't use this model/);
    assert.equal(turn.reconnecting, undefined);
    assert.equal(env.outbox.list().length, 0);
  } finally {
    env.close();
  }
});
