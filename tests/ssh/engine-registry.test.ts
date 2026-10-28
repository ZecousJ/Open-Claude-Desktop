/**
 * R9-S3: the engine registry and `Engine.owns()`. Conversations on an SSH
 * host get that host's engine; every call that names a conversation, made
 * on the local engine by any IPC domain, reaches the engine that runs it;
 * stopping or failing one engine never touches another's conversations;
 * SSH engines stop with their host, the administrator's switch, sign-out
 * and idleness; waiting messages come back after a restart. Codex itself
 * is a stand-in here (see ssh-launcher.test.ts for the real one).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPolicy } from "../../shared/client-policy";
import type { AppEvent, Conversation, Turn } from "../../shared/types";
import { Engine } from "../../electron/engine/engine";
import {
  sameEnvironment,
  type EngineLauncher,
} from "../../electron/engine/engine-types";
import {
  EngineRegistry,
  registryOf,
} from "../../electron/engine/engine-registry";
import { Store } from "../../electron/store/store";
import { Outbox, newOutboxId } from "../../electron/ssh/outbox";
import { registerConversationHandlers } from "../../electron/ipc/conversations";
import type { SshServiceApi } from "../../electron/ipc/ssh";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function turn(id: string, status: Turn["status"] = "completed"): Turn {
  return { id, prompt: id, attachments: [], items: [], status, createdAt: 1 };
}

function conversation(
  id: string,
  patch: Partial<Conversation> = {},
): Conversation {
  return {
    id,
    title: id,
    mode: "code",
    providerId: "p",
    model: "m",
    cwd: "/srv/app",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    ...patch,
  };
}

function fakeRpc(
  calls: { engine: string; method: string; params?: any }[],
  name: string,
) {
  return {
    connected: true,
    call: async (method: string, params: any) => {
      calls.push({ engine: name, method, params });
      if (method === "thread/start")
        return { thread: { id: `${name}-thread` } };
      if (method === "turn/start") return { turn: { id: `${name}-turn` } };
      return {};
    },
    respond: (id: unknown, result: unknown) =>
      calls.push({ engine: name, method: "respond", params: { id, result } }),
    reject: () => {},
    stop: async () => {
      calls.push({ engine: name, method: "stop" });
    },
  };
}

function setup(options: { idleMs?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cx-registry-"));
  let store = new Store(root);
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
  const calls: { engine: string; method: string; params?: any }[] = [];
  const events: AppEvent[] = [];
  const makeLocal = () => {
    const engine = new Engine(
      store,
      "unused",
      () => "",
      (e) => events.push(e),
    );
    engine.policy = () => openPolicy;
    engine.ensure = async () => {
      engine.rpc = fakeRpc(calls, "local") as any;
    };
    return engine;
  };
  let local: Engine | undefined = makeLocal();
  const listeners = new Set<(event: AppEvent) => void>();
  const activated = new Set<() => void>();
  const deactivating = new Set<() => void | Promise<void>>();
  const connects: { hostId: string; interactive?: boolean }[] = [];
  const service: SshServiceApi = {
    hosts: {
      get: (id: string) =>
        id === "gone" ? undefined : ({ id, label: `box-${id}` } as any),
    } as any,
    connection: () => {
      throw new Error("not used");
    },
    existing: () => undefined,
    connect: async (hostId, interactive) => {
      connects.push({ hostId, interactive });
      return { state: "ready" };
    },
    allowed: () => true,
  };
  const launchers: string[] = [];
  const folders: { folder?: string; hostId?: string }[] = [];
  let refuseFolders = false;
  const registry = new EngineRegistry(() => local);
  registry.bind({
    ssh: () => service,
    dataRoot: root,
    idleMs: options.idleMs ?? 60_000,
    allowedFolder: (folder, environment) => {
      folders.push({
        folder,
        hostId: environment?.kind === "ssh" ? environment.hostId : undefined,
      });
      if (refuseFolders)
        throw new Error("Choose the remote folder with the folder picker.");
    },
    push: (event) => events.push(event),
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onAccountActivated: (cb) => {
      activated.add(cb);
      return () => activated.delete(cb);
    },
    onAccountDeactivating: (cb) => {
      deactivating.add(cb);
      return () => deactivating.delete(cb);
    },
    launcher: (hostId): EngineLauncher => {
      launchers.push(hostId);
      return {
        environment: { kind: "ssh", hostId },
        label: `box-${hostId}`,
        platform: "linux",
        waiting: () => false,
        launch: async () => {
          throw new Error("not used");
        },
        started() {},
        exited() {},
        failed() {},
        dispose: async () => {},
      };
    },
  });
  /** Gives an SSH host's engine a Codex stand-in. */
  const remote = (hostId: string) => {
    const engine = registry.forEnvironment({ kind: "ssh", hostId });
    engine.ensure = async () => {
      engine.rpc = fakeRpc(calls, hostId) as any;
    };
    return engine;
  };
  return {
    root,
    get store() {
      return store;
    },
    get local() {
      return local!;
    },
    registry,
    calls,
    events,
    connects,
    launchers,
    folders,
    refuseFolders: (value: boolean) => (refuseFolders = value),
    remote,
    emit: (event: AppEvent) => {
      for (const cb of listeners) cb(event);
    },
    activate: () => {
      for (const cb of activated) cb();
    },
    deactivate: async () => {
      for (const cb of deactivating) await cb();
    },
    /** A new account (or a restart): another store and local engine. */
    switchAccount: () => {
      store.flush();
      store = new Store(root);
      local = makeLocal();
    },
    signOut: () => {
      local = undefined;
    },
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("each conversation gets the engine of its environment", () => {
  const env = setup();
  try {
    env.store.conversations.push(
      conversation("here"),
      conversation("there", { environment: { kind: "ssh", hostId: "h1" } }),
      conversation("also-there", {
        environment: { kind: "ssh", hostId: "h1" },
      }),
      conversation("elsewhere", { environment: { kind: "ssh", hostId: "h2" } }),
    );
    const r = env.registry;
    assert.equal(r.forConversation("here"), env.local);
    assert.equal(r.forConversation(), env.local);
    const h1 = r.forConversation("there");
    assert.notEqual(h1, env.local);
    assert.equal(r.forConversation("also-there"), h1);
    assert.deepEqual(h1.environment, { kind: "ssh", hostId: "h1" });
    assert.notEqual(r.forConversation("elsewhere"), h1);
    assert.deepEqual(env.launchers, ["h1", "h2"]);
    assert.equal(r.all().length, 3);
    assert.equal(registryOf(env.local), r);
    // owns(): missing environment means this computer.
    assert.ok(env.local.owns(conversation("x")));
    assert.ok(
      !env.local.owns(
        conversation("x", { environment: { kind: "ssh", hostId: "h1" } }),
      ),
    );
    assert.ok(h1.owns({ environment: { kind: "ssh", hostId: "h1" } }));
    assert.ok(!h1.owns({ environment: { kind: "ssh", hostId: "h2" } }));
    assert.ok(sameEnvironment(undefined, { kind: "local" }));
  } finally {
    env.close();
  }
});

test("calls on the local engine reach the engine that runs the conversation", async () => {
  const env = setup();
  try {
    const running = conversation("there", {
      environment: { kind: "ssh", hostId: "h1" },
      threadId: "h1-thread",
      turns: [turn("t1", "inProgress")],
    });
    env.store.conversations.push(running);
    const h1 = env.remote("h1");
    await h1.ensure({} as any);
    (h1 as any).routes.set("h1-thread", "there");
    (h1 as any).loaded.add("h1-thread");
    await env.local.interrupt("there");
    assert.deepEqual(
      env.calls
        .filter((c) => c.method === "turn/interrupt")
        .map((c) => c.engine),
      ["h1"],
    );
    // An approval request from the host shows with the local engine's and
    // is answered on the host.
    (h1 as any).request({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "h1-thread" },
    });
    // Every app-server numbers its own requests: the host's carry the host.
    const ids = env.local.approvals.map((a) => a.id);
    assert.deepEqual(ids, ["ssh:h1:number:7"]);
    env.local.approve(ids[0], { decision: "accept" });
    assert.deepEqual(
      env.calls
        .filter((c) => c.method === "respond")
        .map((c) => [c.engine, c.params.id]),
      [["h1", 7]],
    );
    assert.deepEqual(env.local.approvals, []);
    // A new conversation on a host goes to that host's engine.
    running.turns[0].status = "completed";
    const created = await env.local.send({
      text: "hi",
      mode: "code",
      cwd: "/srv/other",
      attachments: [],
      providerId: "p",
      model: "m",
      environment: { kind: "ssh", hostId: "h1" },
    });
    assert.deepEqual(created.environment, { kind: "ssh", hostId: "h1" });
    assert.equal(
      env.calls.filter((c) => c.method === "turn/start").at(-1)?.engine,
      "h1",
    );
    // A host engine refuses a conversation of this computer.
    env.store.conversations.push(conversation("here"));
    await assert.rejects(h1.interrupt("here"), /runs on this computer/);
  } finally {
    env.close();
  }
});

test("stopping or losing one engine leaves the others' conversations alone", async () => {
  const env = setup();
  try {
    const here = conversation("here", { turns: [turn("a", "inProgress")] });
    const there = conversation("there", {
      environment: { kind: "ssh", hostId: "h1" },
      turns: [turn("b", "inProgress")],
    });
    env.store.conversations.push(here, there);
    const h1 = env.remote("h1");
    assert.equal(env.local.ownBusy(), true);
    assert.equal(h1.ownBusy(), true);
    assert.equal(env.registry.isBusy(), true);
    await env.local.stop();
    assert.equal(here.turns[0].status, "interrupted");
    assert.equal(there.turns[0].status, "inProgress");
    assert.equal(env.local.ownBusy(), false);
    // The quit prompt and the scheduler still see the host's task.
    assert.equal(env.local.isBusy(), true);
    here.turns[0].status = "inProgress";
    await h1.stop();
    assert.equal(there.turns[0].status, "interrupted");
    assert.equal(here.turns[0].status, "inProgress");
  } finally {
    env.close();
  }
});

test("a host's engine stops when it disconnects or SSH is turned off, and never for its own errors", async () => {
  const env = setup();
  try {
    const h1 = env.remote("h1");
    env.remote("h2");
    env.emit({
      type: "ssh-status",
      hostId: "h1",
      status: { state: "error", code: "engine-exited", message: "x" },
    } as AppEvent);
    assert.equal(
      env.registry.forEnvironment({ kind: "ssh", hostId: "h1" }),
      h1,
    );
    env.emit({
      type: "ssh-status",
      hostId: "h1",
      status: { state: "idle" },
    } as AppEvent);
    await delay(10);
    assert.notEqual(
      env.registry.forEnvironment({ kind: "ssh", hostId: "h1" }),
      h1,
    );
    const h2 = env.registry.forEnvironment({ kind: "ssh", hostId: "h2" });
    env.emit({
      type: "ssh-status",
      hostId: "h2",
      status: { state: "error", code: "policy-disabled", message: "off" },
    } as AppEvent);
    await delay(10);
    assert.notEqual(
      env.registry.forEnvironment({ kind: "ssh", hostId: "h2" }),
      h2,
    );
  } finally {
    env.close();
  }
});

test("an idle host engine stops after a while; a busy one keeps running", async () => {
  const env = setup({ idleMs: 30 });
  try {
    const there = conversation("there", {
      environment: { kind: "ssh", hostId: "h1" },
      turns: [turn("b", "inProgress")],
    });
    env.store.conversations.push(there);
    const h1 = env.remote("h1");
    await delay(100);
    assert.equal(
      env.registry.forEnvironment({ kind: "ssh", hostId: "h1" }),
      h1,
    );
    there.turns[0].status = "completed";
    await delay(100);
    assert.notEqual(
      env.registry.forEnvironment({ kind: "ssh", hostId: "h1" }),
      h1,
    );
  } finally {
    env.close();
  }
});

test("a host that is ready again gets its waiting messages", async () => {
  const env = setup();
  try {
    const id = newOutboxId();
    env.store.conversations.push(
      conversation("there", {
        environment: { kind: "ssh", hostId: "h1" },
        turns: [
          {
            ...turn(id, "inProgress"),
            prompt: "later",
            reconnecting: "Will send when box-h1 reconnects",
          },
        ],
      }),
    );
    new Outbox(env.store.root).put({
      id,
      conversationId: "there",
      hostId: "h1",
      text: "later",
      attachments: [],
      mode: "code",
      providerId: "p",
      model: "m",
      createdAt: 1,
    });
    // The registry's outbox is read when the first host engine is made.
    const h1 = env.remote("h1");
    let delivered = 0;
    h1.deliverOutbox = async () => {
      delivered++;
    };
    env.emit({
      type: "ssh-status",
      hostId: "h2",
      status: { state: "ready" },
    } as AppEvent);
    env.emit({
      type: "ssh-status",
      hostId: "h1",
      status: { state: "ready" },
    } as AppEvent);
    await delay(10);
    assert.equal(delivered, 1);
  } finally {
    env.close();
  }
});

test("after a restart waiting messages show as waiting again and their hosts are reached quietly", async () => {
  const env = setup();
  try {
    const id = newOutboxId();
    env.store.conversations.push(
      conversation("there", {
        environment: { kind: "ssh", hostId: "h1" },
        turns: [{ ...turn(id, "inProgress"), prompt: "later" }],
      }),
      conversation("orphan", {
        environment: { kind: "ssh", hostId: "gone" },
        turns: [{ ...turn("x", "completed") }],
      }),
    );
    const outbox = new Outbox(env.store.root);
    const base = {
      attachments: [],
      mode: "code" as const,
      providerId: "p",
      model: "m",
      createdAt: 1,
      text: "later",
    };
    outbox.put({ ...base, id, conversationId: "there", hostId: "h1" });
    const orphan = newOutboxId();
    outbox.put({
      ...base,
      id: orphan,
      conversationId: "orphan",
      hostId: "gone",
    });
    // Restart: the store marks the waiting turn stopped by the app closing.
    env.switchAccount();
    const stopped = env.store.conversation("there").turns[0];
    assert.equal(stopped.status, "interrupted");
    env.activate();
    await delay(20);
    const waiting = env.store.conversation("there").turns[0];
    assert.equal(waiting.status, "inProgress");
    assert.equal(waiting.stopReason, undefined);
    assert.equal(waiting.reconnecting, "Will send when box-h1 reconnects");
    assert.deepEqual(env.connects, [{ hostId: "h1", interactive: false }]);
    assert.ok(
      env.events.some(
        (e) => e.type === "conversation" && e.conversation.id === "there",
      ),
    );
    // The message whose conversation has no turn for it anymore is dropped.
    assert.deepEqual(
      new Outbox(env.store.root).list().map((e) => e.id),
      [id],
    );
  } finally {
    env.close();
  }
});

test("a new account's local engine replaces the old one; sign-out stops the host engines", async () => {
  const env = setup();
  try {
    const old = env.local;
    const h1 = env.remote("h1");
    assert.ok(old.peers);
    env.switchAccount();
    assert.notEqual(env.registry.forConversation(), old);
    assert.equal(old.peers, undefined);
    assert.equal(registryOf(old), undefined);
    assert.notEqual(
      env.registry.forEnvironment({ kind: "ssh", hostId: "h1" }),
      h1,
    );
    env.remote("h2");
    await env.deactivate();
    assert.equal(env.registry.all().length, 1);
    env.signOut();
    assert.deepEqual(env.registry.all(), []);
    assert.throws(() => env.registry.forConversation("x"), /Sign in/);
  } finally {
    env.close();
  }
});

test("the send IPC starts SSH conversations only for Code, in a folder chosen on the host", async () => {
  const env = setup();
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    registerConversationHandlers((name, fn) => handlers.set(name, fn), {
      get store() {
        return env.store;
      },
      get engine() {
        return env.local;
      },
      replyFeedback: { deleteConversation() {} } as any,
      selectedAttachments: new Map(),
      allowedFolder: () => {
        throw new Error("Choose the working folder with the folder picker.");
      },
      noActive: () => {},
    });
    env.remote("h1");
    const send = handlers.get("send")!;
    const input = {
      text: "hi",
      mode: "code",
      cwd: "/srv/app",
      attachments: [],
      providerId: "p",
      model: "m",
      environment: { kind: "ssh", hostId: "h1" },
    };
    await assert.rejects(send({ ...input, mode: "chat" }), /only for Code/);
    await assert.rejects(
      send({
        ...input,
        environment: { kind: "ssh", hostId: "-oProxyCommand=x" },
      }),
    );
    env.refuseFolders(true);
    await assert.rejects(send(input), /remote folder/);
    env.refuseFolders(false);
    const c = await send(input);
    assert.deepEqual(c.environment, { kind: "ssh", hostId: "h1" });
    assert.deepEqual(env.folders.at(-1), { folder: "/srv/app", hostId: "h1" });
    // A conversation keeps its environment.
    env.store.conversation(c.id).turns.at(-1)!.status = "completed";
    await assert.rejects(
      send({ ...input, conversationId: c.id, environment: { kind: "local" } }),
      /runs somewhere else/,
    );
    await send({
      ...input,
      conversationId: c.id,
      environment: undefined,
      cwd: undefined,
    });
    assert.equal(
      env.calls
        .filter((call) => call.method === "turn/start")
        .every((call) => call.engine === "h1"),
      true,
    );
    // A local project's folder never replaces an SSH conversation's.
    env.store.projects.push({
      id: "proj",
      name: "P",
      cwd: "/Users/me/p",
    } as any);
    handlers.get("updateConversation")!(c.id, { projectId: "proj" });
    assert.equal(env.store.conversation(c.id).cwd, "/srv/app");
  } finally {
    env.close();
  }
});

test("deleting an SSH conversation archives on the host's running engine and never starts one", async () => {
  const env = setup();
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    registerConversationHandlers((name, fn) => handlers.set(name, fn), {
      get store() {
        return env.store;
      },
      get engine() {
        return env.local;
      },
      replyFeedback: { deleteConversation() {} } as any,
      selectedAttachments: new Map(),
      allowedFolder: () => {},
      noActive: () => {},
    });
    env.store.conversations.push(
      conversation("idle-host", {
        environment: { kind: "ssh", hostId: "h9" },
        threadId: "t-idle",
      }),
      conversation("live-host", {
        environment: { kind: "ssh", hostId: "h1" },
        threadId: "t-live",
      }),
    );
    // No engine runs for h9: deleting doesn't create or start one.
    assert.equal(env.registry.running("idle-host"), undefined);
    await handlers.get("deleteConversation")!("idle-host");
    assert.deepEqual(env.launchers, []);
    assert.ok(!env.store.conversations.some((c) => c.id === "idle-host"));
    // h1's engine runs: the thread is archived there, not on this computer.
    const h1 = env.remote("h1");
    await h1.ensure({} as any);
    await handlers.get("deleteConversation")!("live-host");
    assert.deepEqual(
      env.calls
        .filter((call) => call.method === "thread/archive")
        .map((call) => call.engine),
      ["h1"],
    );
  } finally {
    env.close();
  }
});
