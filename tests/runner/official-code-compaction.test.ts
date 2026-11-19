import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AppContext } from "../../electron/app/app-context";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import type { Conversation } from "../../shared/types";
import type { TurnDoc } from "../../shared/web-docs";
import { isAcceptedCodeCompaction } from "../../shared/agent-api";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { encodeWireValue } from "../../shared/web-wire";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  useElectronShim();
  const [
    { Engine },
    { registerComposerHandlers },
    { CloudStore },
    { run, newSession },
    { submitOfficialCodeFollowup },
  ] = await Promise.all([
    import("../../electron/engine/engine"),
    import("../../electron/ipc/composer"),
    import("../../runner/src/cloud-store"),
    import("../../runner/src/dispatcher-sessions"),
    import("../../runner/src/official-code-followup"),
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-code-compact-"));
  const web = memoryWebstore();
  let onTurnWrite = async (_doc: TurnDoc) => {};
  let onTurnAck = async (_doc: TurnDoc) => {};
  const open = (name: string) =>
    CloudStore.open({
      root: path.join(root, name),
      userId: 1,
      log() {},
      transport: {
        async request(op, user, body) {
          if (
            op !== "store.turns.put" ||
            !body ||
            typeof body !== "object" ||
            !("turns" in body) ||
            !Array.isArray(body.turns)
          )
            return web.request(op, user, body);
          for (const doc of body.turns) await onTurnWrite(doc);
          const response = await web.request(op, user, body);
          for (const doc of body.turns) await onTurnAck(doc);
          return body.turns.length === 1 ? { revision: 1 } : response;
        },
      },
    });
  const store = await open("profile");
  const conversation: Conversation = {
    id: "existing-session",
    title: "Existing Code",
    mode: "code",
    providerId: "fixture",
    model: "fixture-model",
    threadId: "existing-thread",
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: false,
    cwd: path.join(store.root, "workspace", "code", "fixture-session"),
    cloudEnvironmentId: "default",
    environment: { kind: "space", spaceId: "fixture-space" },
    turns: [
      {
        id: "first-turn",
        prompt: "Initial prompt",
        attachments: [],
        items: [],
        status: "completed",
        createdAt: 1,
      },
    ],
  };
  fs.mkdirSync(conversation.cwd!, { recursive: true });
  store.conversations.push(conversation);
  store.settings.providers = [
    {
      id: "fixture",
      name: "Fixture",
      model: "fixture-model",
      models: [],
      baseUrl: "https://fixture.invalid/v1",
      protocol: "responses",
    },
  ];
  await store.sync();

  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { environment: conversation.environment },
  );
  const calls: Array<[string, object]> = [];
  engine.ensure = async () => {};
  engine.windowsSandbox.ensureReady = async () => {};
  engine.rpc = {
    call: async (method: string, args: object) => {
      calls.push([method, args]);
      return {};
    },
  } as unknown as NonNullable<typeof engine.rpc>;
  const options = { cwd: root, config: {}, developerInstructions: "" };
  engine.threadOptions = () => options;
  const local = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = {
    store,
    remote: true,
    userId: 1,
    spaceRoot: () => store.root,
    engine: local,
    engineFor: () => engine,
    handlers,
    accountRetiring: false,
    activeAccount: { id: "owner" },
    accountActivationIdentity: {},
    signedOut: false,
    officialSessionIdentity() {
      return this.accountActivationIdentity;
    },
    setAccessToken() {},
    engineRunning: () => true,
    onEvent: () => () => {},
  };
  registerComposerHandlers(
    (method, handler) => handlers.set(method, handler),
    ctx as unknown as AppContext,
  );
  const dispatcher = {
    guard: { modes: ["code"] },
    methods: ["compactConversation"],
    options: {},
    now: () => 1,
    contextFor: async () => ctx,
    context: () => ctx,
    run,
    newSession,
  } as unknown as Dispatcher;
  const compact = (args: unknown[]) =>
    dispatcher.run(
      {
        t: "call",
        id: "fixture",
        method: "compactConversation",
        user: { id: 1, accessToken: "fixture" },
        deadlineMs: 1000,
        args: encodeWireValue(args),
      } as CallFrame,
    );
  const official = (uuid: string) =>
    submitOfficialCodeFollowup(dispatcher, {} as CallFrame, ctx as never, {
      key: cloudCodeSessionKey(conversation, ctx.activeAccount.id), wrapped: true,
    }, {
      codeOrganizationId: organizationUuid(ctx.activeAccount.id),
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ events: [{ payload: {
        type: "user", uuid, message: { role: "user", content: "/compact" },
      } }] })),
    }, () => true);
  t.after(async () => {
    await store.close();
    for (const timer of engine.notificationTimer.values()) clearTimeout(timer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    conversation,
    engine,
    compact,
    official,
    calls,
    open,
    web,
    ctx,
    options,
    beforeTurnWrite: (fn: typeof onTurnWrite) => {
      onTurnWrite = fn;
    },
    beforeTurnAck: (fn: typeof onTurnAck) => {
      onTurnAck = fn;
    },
  };
}

const requestId = "450e4d5a-dad4-488f-8b2a-5e1780e42de7";

test("Runner compacts the same Code thread only after the exact provisional turn is acknowledged", async (t) => {
  const f = await fixture(t);
  const arrived = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  f.beforeTurnAck(async (doc) => {
    if (
      doc.turn.compactionRequestId === requestId &&
      !isAcceptedCodeCompaction(doc.turn)
    ) {
      arrived.resolve();
      await release.promise;
    }
  });
  const submit = f.official(requestId);
  await Promise.race([arrived.promise, submit.then(async (response) => {
    assert.fail(Buffer.from(response.body).toString());
  })]);
  assert.equal(f.conversation.turns.length, 2);
  assert.deepEqual(f.calls, [
    [
      "thread/resume",
      { threadId: "existing-thread", ...f.options, excludeTurns: true },
    ],
  ]);
  assert.equal(f.web.users.get(1)?.turns.get(f.conversation.id)?.size, 2);
  release.resolve();
  assert.equal((await submit).status, 200);
  assert.deepEqual(f.calls.at(-1), [
    "thread/compact/start",
    { threadId: "existing-thread" },
  ]);
  await f.store.confirmOfficialCodeCompaction(
    f.conversation,
    requestId,
    () => true,
  );
  assert.equal(f.conversation.turns.at(-1)?.compactionAccepted, true);
  assert.equal((await f.official(requestId)).status, 200);
  assert.equal(f.calls.length, 2);

  const notify = (method: string, params: object) =>
    f.engine.notification({
      method,
      params: { threadId: "existing-thread", ...params },
    });
  notify("turn/started", { turn: { id: "codex-compact-turn" } });
  notify("turn/completed", {
    turn: { id: "codex-compact-turn", status: "completed" },
  });
  f.web.failNext("store.turns.delete");
  await f.store.sync();
  assert.equal(f.web.users.get(1)?.turns.get(f.conversation.id)?.size, 3);
  const reopened = await f.open("reopened");
  try {
    const saved = reopened.conversation(f.conversation.id);
    assert.deepEqual(
      saved.turns.map((turn) => turn.id),
      ["first-turn", "codex-compact-turn"],
    );
    await reopened.confirmOfficialCodeCompaction(
      saved,
      requestId,
      () => true,
    );
  } finally {
    await reopened.close();
  }
});

test("legacy Web composer compacts with a server-created ID and rejects a renderer-supplied ID or foreign viewer", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.compact([f.conversation.id, "forged-id"]),
    /unavailable/,
  );
  f.conversation.sessionAuthors = {
    ownerAccountUuid: "owner",
    viewerAccountUuid: "other",
  };
  await assert.rejects(f.compact([f.conversation.id]), /changed/);
  assert.equal((await f.official(requestId)).status, 409);
  assert.deepEqual(f.calls, []);
  f.conversation.sessionAuthors.viewerAccountUuid = "owner";
  await f.compact([f.conversation.id]);
  assert.match(
    f.conversation.turns.at(-1)?.compactionRequestId ?? "",
    /^[a-f0-9-]{36}$/,
  );
  assert.deepEqual(f.calls.at(-1), [
    "thread/compact/start",
    { threadId: "existing-thread" },
  ]);
});

test("lost compaction write reply blocks dispatch and remains unaccepted after CloudStore reopen", async (t) => {
  const f = await fixture(t);
  f.beforeTurnAck(async (doc) => {
    if (doc.turn.compactionRequestId) throw Error("Reply lost");
  });
  assert.equal((await f.official(requestId)).status, 409);
  assert.equal(f.conversation.turns.length, 1);
  assert.ok(f.calls.every(([method]) => method !== "thread/compact/start"));
  assert.throws(
    () => f.store.conversation(f.conversation.id),
    /Reopen the account/,
  );
  const reopened = await f.open("reopened");
  try {
    const saved = reopened.conversation(f.conversation.id);
    assert.equal(saved.turns.at(-1)?.status, "interrupted");
    assert.equal(saved.turns.at(-1)?.compactionRequestId, requestId);
    await assert.rejects(
      reopened.confirmOfficialCodeCompaction(
        saved,
        requestId,
        () => true,
      ),
      /could not be confirmed/,
    );
  } finally {
    await reopened.close();
  }
});
