import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { updateOfficialCodeCloudOffer } from "../electron/ipc/official-code-new-task";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { codeSessionState } from "../electron/official-ui/native/code-session-state";
import { CodeSendStart, officialCodeNewTaskInput, officialCodeSendStart } from "../electron/engine/code-send-start";
import { EngineRegistry } from "../electron/engine/engine-registry";
import { registerConversationTurnHandlers } from "../electron/ipc/conversation-turn-handlers";
import type { Conversation } from "../shared/types";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-code-recovery-"));
  let owner = "account-one",
    identity = {};
  const c = {
    id: "session",
    title: "Recovery",
    mode: "code",
    cwd: root,
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "base",
        prompt: "base",
        attachments: [],
        items: [],
        status: "inProgress",
        createdAt: 1,
      },
    ],
  } as Conversation;
  let sends = 0;
  const ctx = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    localListConversations: async () => [structuredClone(c)],
    localLoadConversation: async () => structuredClone(c),
    async localCall(
      name: string,
      input: any,
      _expected?: unknown,
    ): Promise<
      | Conversation
      | { approvals: never[] }
      | { status: "accepted" }
      | { messageId: string; conversation: Conversation }
      | undefined
    > {
      if (name === "snapshot") return { approvals: [] };
      if (name === "send") {
        sends++;
        c.turns.push({
          id: `turn-${sends}`,
          prompt: input.text,
          attachments: [],
          items: [],
          createdAt: sends + 1,
          status: "completed",
        });
        return structuredClone(c);
      }
      throw Error(`Unexpected call: ${name}`);
    },
    log() {},
    onEvent: (_fn: (e: any) => void) => () => {},
  };
  const attach = () => {
    identity = {};
    const handlers = new Map<string, (...args: any[]) => any>();
    registerExperimentalCodeSessions({
      ctx,
      on(name: string, fn: (...args: any[]) => any) {
        handlers.set(name, fn);
      },
      emit() {},
    } as never);
    return (name: string, ...args: unknown[]) =>
      handlers.get(`LocalSessions.${name}`)!("local_session", ...args);
  };
  return {
    root,
    c,
    ctx,
    attach,
    sends: () => sends,
    owner(value: string) {
      owner = value;
      identity = {};
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Code queue survives a new adapter, retains order/cancellation and sends once with a stable UUID", async () => {
  const f = fixture();
  try {
    const first = f.attach();
    await first("sendMessage", "one", [], [], [], "later", {}, "uuid-one");
    await first("sendMessage", "two", [], [], [], "later", {}, "uuid-two");
    await first("reorderQueuedMessage", "uuid-two", "uuid-one");
    const reopened = f.attach();
    const transcript = await reopened("getTranscript");
    assert.deepEqual(
      transcript.slice(-2).map((r: any) => [r.uuid, r.priority]),
      [
        ["uuid-two", "later"],
        ["uuid-one", "later"],
      ],
    );
    assert.equal(await reopened("cancelQueuedMessage", "uuid-two"), true);
    f.c.turns[0].status = "completed";
    await reopened("sendSteeredNow", "uuid-one");
    assert.equal(f.sends(), 1);
    const again = f.attach();
    assert.ok(
      (await again("getTranscript")).some(
        (r: any) => r.uuid === "uuid-one" && r.message.content === "one",
      ),
    );
    assert.deepEqual(codeSessionState(f.ctx as never).read().queues, []);
    assert.equal(f.sends(), 1);
  } finally {
    f.cleanup();
  }
});

test("a saved native task offer owns its input until the offer is resolved", async () => {
  const f = fixture();
  try {
    f.c.turns[0].status = "completed";
    f.c.codeNewTask = {
      id: "task_1234abcd",
      text: "unrelated request",
      model: "m",
      providerId: "p",
      attachments: [],
      nativeInput: { uuid: "offer-input", createdAt: 5 },
    };
    const storage = codeSessionState(f.ctx as never);
    storage.write({
      version: 1,
      queues: [["session", [{
        uuid: "offer-input", message: "unrelated request", state: "submitting", createdAt: 5, before: ["base"],
      }]]],
      messageIds: [],
    });
    const reopened = f.attach();
    const session = await reopened("getSession");
    assert.equal(session.backgroundTaskSuggestions[0].id, "task_1234abcd");
    assert.equal(session.heldInput, undefined);
    assert.ok(!(await reopened("getTranscript")).some((row: { uuid: string }) => row.uuid === "offer-input"));
    assert.equal(await reopened("cancelQueuedMessage", "offer-input"), false);
    assert.equal(await reopened("promoteQueuedMessage", "offer-input"), false);
    assert.equal(await reopened("sendSteeredNow", "offer-input"), false);
    assert.equal(f.sends(), 0);
    assert.equal(storage.read().queues[0][1][0].uuid, "offer-input");
    assert.equal(storage.read().commandReceipts?.[0][1][0][0], "offer-input");

    delete f.c.codeNewTask;
    const unresolved = await f.attach()("getSession");
    assert.deepEqual(unresolved.sendsHeldAfterError, ["offer-input"]);
    assert.equal(f.sends(), 0);
  } finally {
    f.cleanup();
  }
});

test("SSH offers survive reopening and resolve in the host folder or a worktree", async () => {
  for (const worktree of [false, true, undefined, "here"] as const) {
    const f = fixture();
    try {
      f.c.environment = { kind: "ssh", hostId: "host" };
      if (worktree === undefined) f.c.worktree = { state: "ready" } as never;
      f.c.turns[0].status = "completed";
      const ctx = f.ctx as any;
      ctx.settings = () => ({ ccNewTaskPrompt: "ask", providers: [{ id: "p", model: "m", models: [] }] });
      ctx.sshCodeEnvironment = () => ({ remoteTarget: { kind: "ssh", hostId: "host" }, homePath: "/home/test" });
      let calls = 0;
      let placement: unknown;
      ctx.localCall = async (name: string, ...args: any[]) => {
        if (name === "snapshot") return { approvals: [] };
        if (name === "send") {
          calls++;
          assert.equal(args[0].continueCodeSession, undefined);
          const native = args[1][officialCodeNewTaskInput];
          assert.equal(native.uuid, "ssh-input");
          f.c.codeNewTask = { id: "task_1234abcd", text: args[0].text, model: "m", providerId: "p", attachments: [], nativeInput: native };
          return structuredClone(f.c);
        }
        if (name === "officialResolveCodeNewTask") {
          placement = args[4];
          const offer = f.c.codeNewTask!;
          delete f.c.codeNewTask;
          if (args[2] === "here") {
            f.c.turns.push({ ...f.c.turns[0], id: "sent", prompt: offer.text, officialCodeEventId: "ssh-input" });
            return structuredClone(f.c);
          }
          return { ...structuredClone(f.c), id: "child", parentSessionId: f.c.id,
            nativeSideSession: { taskId: offer.id }, turns: [{ ...f.c.turns[0], officialCodeEventId: "ssh-input" }] };
        }
        throw Error(`Unexpected call: ${name}`);
      };
      const first = f.attach();
      await first("sendMessage", "New work", [], [], [], "later", {}, "ssh-input", false,
        "New work", [], undefined, undefined, [], { personSent: true });
      const reopened = f.attach();
      assert.equal((await reopened("getSession")).backgroundTaskSuggestions[0].id, "task_1234abcd");
      assert.equal((await reopened("getSession")).heldInput, undefined);
      assert.equal(await reopened("acceptSideSessionOffer", "task_1234abcd", { target: "cloud" }), false);
      if (worktree === "here") {
        assert.equal(await reopened("popBackgroundTaskSuggestionById", "task_1234abcd", false), true);
        assert.equal(placement, undefined);
      } else {
        assert.equal(await reopened("acceptSideSessionOffer", "task_1234abcd", { target: "local", ...(worktree === undefined ? {} : { useWorktree: worktree }) }), true);
        assert.deepEqual(placement, { worktree: worktree ?? true });
      }
      assert.equal(calls, 1);
      assert.deepEqual(codeSessionState(f.ctx as never).read().queues, []);
    } finally { f.cleanup(); }
  }
});

test("native SSH input passes its receipt through the real send boundary; WSL does not", async () => {
  for (const kind of ["ssh", "wsl"] as const) {
    const f = fixture();
    try {
      f.c.environment = kind === "ssh" ? { kind, hostId: "host" } : { kind, distro: "test" };
      let received: any;
      const engine: any = { send: async (...args: any[]) => { received = args; return f.c; } };
      const registry = new EngineRegistry(() => engine);
      const unbind = registry.bind({ ssh: () => undefined, dataRoot: f.root, allowedFolder: () => {}, onEvent: () => () => {} });
      const context: any = { accountActivationIdentity: {}, accountRetiring: false, activeAccount: { id: "account-one" },
        store: { conversation: () => f.c, projects: [] }, engine, selectedAttachments: new Map() };
      const handlers = new Map<string, (...args: any[]) => any>();
      registerConversationTurnHandlers({ context, handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) } as never);
      await handlers.get("send")!({ conversationId: f.c.id, mode: "code", text: "New work", attachments: [], providerId: "p", model: "m" },
        { [officialCodeSendStart]: new CodeSendStart(), [officialCodeNewTaskInput]: { uuid: "input", createdAt: 1 } });
      assert.deepEqual(received[3].nativeNewTaskInput, kind === "ssh" ? { uuid: "input", createdAt: 1 } : undefined);
      unbind();
    } finally { f.cleanup(); }
  }
});

test("an unconfirmed SSH offer resolution remains held after reopening", async () => {
  const f = fixture();
  try {
    f.c.environment = { kind: "ssh", hostId: "host" };
    f.c.turns[0].status = "completed";
    f.c.codeNewTask = { id: "task_1234abcd", text: "New work", model: "m", providerId: "p", attachments: [], nativeInput: { uuid: "ssh-input", createdAt: 5 } };
    const ctx = f.ctx as any;
    ctx.sshCodeEnvironment = () => ({ remoteTarget: { kind: "ssh", hostId: "host" } });
    ctx.localCall = async (name: string) => {
      if (name === "snapshot") return { approvals: [] };
      if (name === "officialResolveCodeNewTask") { delete f.c.codeNewTask; throw Error("unconfirmed"); }
      throw Error(`Unexpected call: ${name}`);
    };
    const storage = codeSessionState(f.ctx as never);
    storage.write({ version: 1, queues: [["session", [{ uuid: "ssh-input", message: "New work", state: "submitting", createdAt: 5, before: ["base"] }]]], messageIds: [] });
    const first = f.attach();
    assert.equal(await first("cancelQueuedMessage", "ssh-input"), false);
    await assert.rejects(first("popBackgroundTaskSuggestionById", "task_1234abcd", false), /unconfirmed/);
    const reopened = f.attach();
    assert.deepEqual((await reopened("getSession")).sendsHeldAfterError, ["ssh-input"]);
    assert.equal(await reopened("sendSteeredNow", "ssh-input"), false);
    assert.equal(f.sends(), 0);
    assert.equal(await reopened("cancelQueuedMessage", "ssh-input"), true);
  } finally { f.cleanup(); }
});

test("a confirmed cloud child reconciles its local offer after adapter restart", async () => {
  const f = fixture();
  try {
    const taskId = "task_1234abcd";
    const messageUuid = "offer-input";
    const cloudSessionId = "session_" + "a".repeat(32);
    f.c.turns[0].status = "completed";
    f.c.codeNewTask = {
      id: taskId, text: "Cloud task", model: "m", providerId: "p", attachments: [],
      nativeInput: { uuid: messageUuid, createdAt: 5 },
    };
    const storage = codeSessionState(f.ctx as never);
    storage.write({
      version: 1,
      queues: [["session", [{ uuid: messageUuid, message: "Cloud task",
        state: "submitting", createdAt: 5, before: ["base"] }]]],
      messageIds: [],
    });
    const context = { store: { conversation: () => f.c, flush: () => {} } };
    const target = { environmentId: "default", repository: "fixture/repository", model: "m" };
    assert.equal(updateOfficialCodeCloudOffer(context, f.c.id, taskId, { kind: "reserve", target }), true);
    assert.equal(updateOfficialCodeCloudOffer(context, f.c.id, taskId,
      { kind: "reserve", target: { ...target, model: "different" } }), false);
    assert.equal(await f.attach()("popBackgroundTaskSuggestionById", taskId, false), false);
    assert.equal(updateOfficialCodeCloudOffer(context, f.c.id, taskId,
      { kind: "confirm", sessionId: cloudSessionId }), true);
    const session = await f.attach()("getSession");
    assert.deepEqual(session.cloudSpawnedTasks, [{ taskId, sessionId: cloudSessionId, title: "Cloud task" }]);
    assert.equal(session.backgroundTaskSuggestions, undefined);
    assert.equal(session.sendsHeldAfterError, undefined);
    assert.equal(await f.attach()("sendSteeredNow", messageUuid), false);
    assert.equal(f.sends(), 0);
    assert.deepEqual(storage.read().queues, []);
  } finally {
    f.cleanup();
  }
});

test("restart holds interrupted work; uncertain delivery is reconciled with history and never auto-resubmitted", async () => {
  const f = fixture();
  try {
    const store = codeSessionState(f.ctx as never);
    store.write({
      version: 1,
      messageIds: [],
      queues: [
        [
          "session",
          [
            {
              uuid: "unknown",
              message: "possibly sent",
              state: "submitting",
              before: ["base"],
              createdAt: 2,
            },
          ],
        ],
      ],
    });
    f.c.turns[0].status = "completed";
    const reopened = f.attach();
    assert.deepEqual((await reopened("getSession")).sendsHeldAfterError, [
      "unknown",
    ]);
    assert.equal(await reopened("sendSteeredNow", "unknown"), false);
    f.c.turns.push({
      id: "received",
      prompt: "possibly sent",
      attachments: [],
      items: [],
      status: "completed",
      createdAt: 2,
    });
    assert.ok(
      (await reopened("getTranscript")).some((r: any) => r.uuid === "unknown"),
    );
    assert.deepEqual(store.read().queues, []);
    assert.equal(f.sends(), 0);
    f.c.turns.at(-1)!.status = "inProgress";
    await reopened(
      "sendMessage",
      "after restart",
      [],
      [],
      [],
      "later",
      {},
      "held",
    );
    f.c.turns.at(-1)!.status = "interrupted";
    f.c.turns.at(-1)!.stopReason = "restart";
    const afterCrash = f.attach();
    assert.deepEqual((await afterCrash("getSession")).sendsHeldAfterError, [
      "held",
    ]);
    assert.ok(
      (await afterCrash("getTranscript")).some((r: any) => r.uuid === "held"),
    );
    assert.equal(f.sends(), 0);
    await afterCrash("sendSteeredNow", "held");
    assert.equal(f.sends(), 1);
  } finally {
    f.cleanup();
  }
});

test("saved Code input stays with its account and blocks deletion until explicitly withdrawn", async () => {
  const f = fixture();
  try {
    const first = f.attach();
    await first(
      "sendMessage",
      "private draft",
      [],
      [],
      [],
      "later",
      {},
      "private",
    );
    f.owner("account-two");
    const second = f.attach();
    assert.ok(
      !(await second("getTranscript")).some((r: any) => r.uuid === "private"),
    );
    f.owner("account-one");
    const back = f.attach();
    assert.ok(
      (await back("getTranscript")).some((r: any) => r.uuid === "private"),
    );
    f.c.turns[0].status = "interrupted";
    const call = f.ctx.localCall;
    let removed = false;
    f.ctx.localCall = async (name, input) => {
      if (name !== "deleteConversation") return call(name, input);
      assert.equal(input, f.c.id);
      removed = true;
    };
    f.ctx.localListConversations = async () =>
      removed ? [] : [structuredClone(f.c)];
    await assert.rejects(back("delete"), /saved Code input/);
    assert.equal(removed, false);
    assert.equal(
      codeSessionState(f.ctx as never).read().queues[0][1][0].uuid,
      "private",
    );

    assert.equal(await back("cancelQueuedMessage", "private"), true);
    await back("delete");
    assert.equal(removed, true);
    assert.deepEqual(codeSessionState(f.ctx as never).read().queues, []);
  } finally {
    f.cleanup();
  }
});

test("invalid saved Code input is preserved and blocks a false success", () => {
  const f = fixture();
  try {
    const store = codeSessionState(f.ctx as never);
    store.write({ version: 1, messageIds: [], queues: [] });
    const directory = path.join(f.root, "official-ui", "native-accounts");
    const file = path.join(
      directory,
      fs.readdirSync(directory)[0],
      "code-input.json",
    );
    fs.writeFileSync(file, "broken payload");
    assert.throws(() => store.read(), /preserved/);
    assert.equal(fs.readFileSync(file, "utf8"), "broken payload");
  } finally {
    f.cleanup();
  }
});

test("a recovered queue resumes after a completed turn without a second user send", async () => {
  const f = fixture();
  try {
    const first = f.attach();
    await first(
      "sendMessage",
      "resume once",
      [],
      [],
      [],
      "later",
      {},
      "resume",
    );
    // A transport retry carrying the same optimistic id is not a new message.
    await first(
      "sendMessage",
      "resume once",
      [],
      [],
      [],
      "later",
      {},
      "resume",
    );
    assert.equal(
      codeSessionState(f.ctx as never).read().queues[0][1].length,
      1,
    );
    f.c.turns[0].status = "completed";
    const reopened = f.attach();
    await reopened("getSession");
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(f.sends(), 1);
    assert.ok(
      (await reopened("getTranscript")).some((r: any) => r.uuid === "resume"),
    );
  } finally {
    f.cleanup();
  }
});

test("a steer interrupted before acknowledgement is retained and matched to its actual history item", async () => {
  const f = fixture();
  try {
    const original = f.ctx.localCall;
    f.ctx.localCall = async (name: string, input: any) => {
      if (name === "steerTurn")
        throw Error("Connection ended before acknowledgement");
      return original(name, input);
    };
    const first = f.attach();
    await assert.rejects(
      first("sendMessage", "steer once", [], [], [], "now", {}, "steered-uuid"),
      /acknowledgement/,
    );
    const saved = codeSessionState(f.ctx as never).read();
    assert.equal(saved.queues[0][1][0].state, "submitting");
    assert.equal(saved.queues[0][1][0].delivery, "steer");
    f.c.turns[0].items.push({
      id: "delivered-item",
      type: "userMessage",
      text: "steer once",
      steered: true,
      clientId: "steer-receipt",
    });
    const reopened = f.attach();
    assert.ok(
      (await reopened("getTranscript")).some(
        (r: any) =>
          r.uuid === "steered-uuid" && r.message.content === "steer once",
      ),
    );
    assert.deepEqual(codeSessionState(f.ctx as never).read().queues, []);
    assert.equal(f.sends(), 0);
  } finally {
    f.cleanup();
  }
});

test("a new same-text steer waits for an older unknown steer to be resolved", async () => {
  const f = fixture();
  try {
    const original = f.ctx.localCall;
    let attempts = 0;
    f.ctx.localCall = async (name: string, input: any) => {
      if (name !== "steerTurn") return original(name, input);
      attempts++;
      if (attempts === 1)
        throw Error("Connection ended before acknowledgement");
      f.c.turns[0].items.push({
        id: "new-steer-item",
        type: "userMessage",
        text: "same steer",
        steered: true,
        clientId: "new-steer-acknowledgement",
      });
      return {
        messageId: "new-steer-acknowledgement",
        conversation: structuredClone(f.c),
      };
    };
    const run = f.attach();
    await assert.rejects(
      run("sendMessage", "same steer", [], [], [], "now", {}, "older-uuid"),
      /acknowledgement/,
    );
    await run("sendMessage", "same steer", [], [], [], "now", {}, "newer-uuid");
    const matchingRows = async () =>
      (await run("getTranscript"))
        .filter((r: any) => r.message.content === "same steer")
        .map((r: any) => [r.uuid, r.priority]);
    assert.deepEqual(
      await matchingRows(),
      [
        ["older-uuid", "later"],
        ["newer-uuid", "later"],
      ],
    );
    assert.equal(attempts, 1);
    assert.equal(await run("cancelQueuedMessage", "older-uuid"), true);
    assert.equal(await run("sendSteeredNow", "newer-uuid"), true);
    assert.deepEqual(await matchingRows(), [["newer-uuid", undefined]]);
    assert.equal(attempts, 2);
  } finally {
    f.cleanup();
  }
});

test("restart keeps both unknown steers when one history item could match either", async () => {
  const f = fixture();
  try {
    codeSessionState(f.ctx as never).write({
      version: 1,
      messageIds: [],
      queues: [
        [
          "session",
          ["first-steer", "second-steer"].map((uuid) => ({
            uuid,
            message: "same steer",
            state: "submitting",
            delivery: "steer",
            before: ["base"],
            beforeItems: [],
            createdAt: 2,
          })),
        ],
      ],
    });
    f.c.turns[0].items.push({
      id: "delivered-item",
      type: "userMessage",
      text: "same steer",
      steered: true,
      clientId: "engine-receipt",
    });
    const run = f.attach();
    assert.deepEqual((await run("getSession")).sendsHeldAfterError, [
      "first-steer",
      "second-steer",
    ]);
    const rows = await run("getTranscript");
    assert.deepEqual(
      rows
        .filter((r: any) => r.message.content === "same steer")
        .map((r: any) => r.uuid),
      ["engine-receipt", "first-steer", "second-steer"],
    );
  } finally {
    f.cleanup();
  }
});

test("an old account's draining send cannot overwrite the newly active account's queue", async () => {
  const f = fixture();
  try {
    let release!: (value: Conversation) => void;
    let submitted!: () => void;
    const started = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    const sending = new Promise<Conversation>((resolve) => {
      release = resolve;
    });
    const original = f.ctx.localCall;
    f.ctx.localCall = async (name: string, input: any) => {
      if (name === "send") {
        submitted();
        return sending;
      }
      return original(name, input);
    };
    const run = f.attach();
    await run("sendMessage", "old account", [], [], [], "later", {}, "old");
    f.c.turns[0].status = "completed";
    const old = assert.rejects(run("sendSteeredNow", "old"), /account changed/);
    await started;
    f.owner("account-two");
    f.c.turns[0].status = "inProgress";
    await run("sendMessage", "new account", [], [], [], "later", {}, "new");
    release(structuredClone(f.c));
    await old;
    const saved = codeSessionState(f.ctx as never).read();
    assert.deepEqual(
      saved.queues[0][1].map((entry) => entry.uuid),
      ["new"],
    );
    assert.ok(
      (await run("getTranscript")).some((row: any) => row.uuid === "new"),
    );
  } finally {
    f.cleanup();
  }
});

test("Stop holds queue durably across a fresh adapter and reconnect events without any send", async () => {
  const f = fixture();
  let event: (e: any) => void = () => {};
  const original = f.ctx.localCall;
  f.c.threadId = "fixture-thread";
  let stops = 0;
  f.ctx.localCall = async (name, input, expected) => {
    if (name !== "interrupt") return original(name, input);
    assert.equal(input, f.c.id);
    assert.deepEqual(expected, {
      turnId: "base",
      turnCreatedAt: 1,
      conversationCreatedAt: 1,
      threadId: "fixture-thread",
    });
    stops++;
    return { status: "accepted" };
  };
  f.ctx.onEvent = (fn) => {
    event = fn;
    return () => {};
  };
  try {
    const first = f.attach();
    await first(
      "sendMessage",
      "held after stop",
      [],
      [],
      [],
      "later",
      {},
      "stop-held",
    );
    await first("stop");
    assert.equal(stops, 1);
    const persisted = codeSessionState(f.ctx as never).read();
    assert.equal(persisted.queues[0][1][0].requiresConfirmation, true);
    f.c.turns[0].status = "completed";
    const reopened = f.attach();
    assert.ok(
      (await reopened("getSession")).sendsHeldAfterError.includes("stop-held"),
    );
    event({ type: "conversation", conversation: structuredClone(f.c) });
    await new Promise((r) => setImmediate(r));
    assert.equal(f.sends(), 0);
    assert.equal(
      codeSessionState(f.ctx as never).read().queues[0][1][0]
        .requiresConfirmation,
      true,
    );
  } finally {
    f.cleanup();
  }
});
