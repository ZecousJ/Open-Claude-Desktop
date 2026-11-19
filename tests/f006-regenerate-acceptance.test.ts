import { beforeF014Stop } from "./support/f014-resource-chain.mjs";
import {
  regenerationErrorAfter,
  regenerationErrorBefore,
  regenerationErrorInput,
  regenerationErrorTarget,
  deriveOfficialRegenerationErrorModule,
} from "../scripts/official-ui-regeneration-error.mjs";
/** Original RETRY protocol with actual local Store/registered handlers/send/branch code.
 * Host setup and provider RPC results are inert; no SDK, network, model or tools. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import ts from "typescript";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
const root =
    process.env.F006_SOURCE_ROOT ?? path.resolve(import.meta.dirname, ".."),
  assets = process.env.F006_ASSETS_ROOT ?? path.join(root, "build/official-ui");
const mod = async (p: string) => import(pathToFileURL(path.join(root, p)).href);
const { createActionRpc, PERFORM_ACTION_PATH } = await mod(
  "electron/official-ui/api/actions.ts",
);
const { loadRegistry, deepCreate, conversationUpdate } = await mod(
  "electron/official-ui/api/timeline.ts",
);
const { newAdapterScope, inAdapterScope } = await mod(
  "electron/official-ui/api/scope.ts",
);
const { Store } = await mod("electron/store/store.ts");
const { registerConversationTurnHandlers } = await mod(
  "electron/ipc/conversation-turn-handlers.ts",
);
const { send, retryResponse, selectPromptVersion, selectReplyVersion, selectChatLeaf } =
  await mod("electron/engine/engine-send.ts");
const { branchFrom, dropWebSearch, assertIncognitoLive } = await mod(
  "electron/engine/engine-turn-setup.ts",
);
const { assertSendable, assertPolicy, assertIdle, assertExtensions } =
  await mod("electron/engine/engine-guards.ts");
const { applyTurnEvent, applyItemEvent, recordOutputFiles } = await mod(
  "electron/engine/engine-events.ts",
);
const registry = loadRegistry(
    path.join(assets, "data/conversation-protocol.json"),
  ),
  input = registry.getMessage(
    "anthropic.bard.api.v1alpha.PerformActionRequest",
  )!,
  output = registry.getMessage(
    "anthropic.bard.api.v1alpha.PerformActionResponse",
  )!;
const mark = { sessionId: "f006-self", version: 1n };
function original(t: any) {
  const file = path.join(
    assets,
    "ui/assets/v1/30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js",
  );
  if (!fs.existsSync(file)) {
    t.skip(
      "Pinned original hub resource required for regeneration consumer comparison",
    );
    return;
  }
  let source = fs.readFileSync(file, "utf8");
  source = beforeF014Stop("30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js", source);
  // Reverse only the exact final F006 module in memory; preserve all earlier pins.
  if (
    createHash("sha256").update(source).digest("hex") ===
    "87194090ced9e671d94d8b6dece3bf02e344e23b4f970447ec172c0a6e3ed781"
  ) {
    const final = source;
    assert.equal(source.split(regenerationErrorAfter).length, 2);
    source = source.replace(regenerationErrorAfter, regenerationErrorBefore);
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      regenerationErrorInput,
    );
    assert.equal(
      deriveOfficialRegenerationErrorModule(regenerationErrorTarget, source),
      final,
    );
  }
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "afc1d3758e53500d00ddc331375621b68bc6c5f100bffa2afbb1a1dd9294a830",
  );
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let cls: any, requestNode: any, retryNotice: any;
  function visit(n: ts.Node) {
    if (ts.isVariableDeclaration(n) && n.name.getText(ast) === "U$")
      cls = n.initializer;
    if (
      ts.isVariableDeclaration(n) &&
      n.name.getText(ast) === "l" &&
      n.initializer?.getText(ast).startsWith("K(yf, {") &&
      n.initializer.getText(ast).includes("inputMode: lu.RETRY")
    )
      requestNode = n.initializer;
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(ast) === "an" &&
      n.arguments[0]?.getText(ast).includes("id: o.droppedRetry.id")
    )
      retryNotice = n;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(cls && requestNode && retryNotice);
  const names = [
    "ownsSession",
    "ownsMark",
    "foreignSeenOnce",
    "settleError",
    "disposeFailures",
    "isSuperseded",
    "drainFailureNotices",
    "keepOptimisticSendsLast",
    "repointLeafAtWaitingSends",
    "deepestWaitingSendRow",
    "waitingTailSendIds",
    "tailLinkSendIds",
    "pendingStubOfServedLeafSend",
    "isOptimisticSendRow",
  ];
  const methods = names.map((name) =>
    cls.members
      .find(
        (m: any) => ts.isMethodDeclaration(m) && m.name.getText(ast) === name,
      )
      .getText(ast),
  );
  const released: string[] = [];
  const methodsValue = vm.runInNewContext(`({${methods.join(",")}})`, {
    e: { FOREIGN_SEEN_CAP: 100 },
    Y: { USER: 1, ASSISTANT: 2 },
    pv: new Set(),
    fb: (id: string) => released.push(id),
  });
  const gate: any = {
    ...methodsValue,
    session: { ownedSessionIds: new Set([mark.sessionId]) },
    floorVersion: 0n,
    latestVersion: 1n,
    foreignSeen: new Set(),
    pendingFailures: [],
    failedVersions: new Map(),
    retryStubByVersion: new Map([[1n, "new-assistant"]]),
    sentByVersion: new Map(),
    markedByVersion: new Map(),
    noticeQueue: [],
    queuedSendIds: [],
    leafComposedSendIds: new Set(),
    residualJoinedAt: new Map(),
    overlay: {
      messages: new Map([
        [
          "new-assistant",
          {
            id: "new-assistant",
            role: 2,
            isComplete: false,
            parentMessageId: "first:user",
          },
        ],
      ]),
      displayGroups: new Map(),
      contentBlocks: new Map(),
    },
    shadow: { messages: new Map(), hasRowFor: () => false },
  };
  const rendered: any[] = [];
  return {
    gate,
    rendered,
    request: () =>
      vm.runInNewContext(requestNode.getText(ast), {
        K: deepCreate,
        yf: input,
        c: { conversationId: "source", existingOnly: true, mutationId: mark },
        fE: () => "new-assistant",
        lu: { RETRY: 2 },
        t: "first:user",
        q7: () => false,
        e: "source",
        R: {},
      }),
    receive(ack: any) {
      gate.settleError(ack.highWaterMark, ack.outcome.value);
      const pending = gate.pendingFailures;
      gate.pendingFailures = [];
      gate.disposeFailures(pending);
      const notices = gate.drainFailureNotices();
      for (const o of notices)
        if (o.droppedRetry)
          vm.runInNewContext(retryNotice.getText(ast), {
            o,
            h: "original-error-code",
            p: o.failure.error?.retryable,
            g: o.failure.error?.displayMessage,
            an: (x: any) => rendered.push(x),
          });
      return notices;
    },
  };
}
async function invoke(ctx: any, request: any) {
  const req: any = Readable.from([Buffer.from(toBinary(input, request))]);
  req.method = "POST";
  req.headers = { "content-type": "application/proto" };
  let body: Buffer;
  await createActionRpc(ctx, registry)(
    req,
    {
      writeHead() {},
      end(b: Buffer) {
        body = b;
      },
    } as any,
    PERFORM_ACTION_PATH,
  );
  return (fromBinary(output, body!) as any).ack;
}
function fixture(mode = "success") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f006-")),
    workspace = path.join(dir, "workspace"),
    store = new Store(dir),
    identity = {};
  const provider = { id: "p", model: "m", models: [], type: "codex" };
  store.settings = {
    ...store.settings,
    providers: [provider],
    activeProviderId: "p",
  };
  const turn = (id: string) => ({
    id,
    prompt: "Self-authored " + id,
    attachments: [],
    items: [
      { id: id + "-answer", type: "agentMessage", text: "Recorded " + id },
    ],
    status: "completed",
    createdAt: 1,
    responseGroupId: id,
    promptGroupId: id,
    promptVersionId: id,
  });
  const c: any = {
    id: "source",
    title: "Self-authored regeneration",
    mode: "chat",
    cwd: workspace,
    threadId: "source-thread",
    providerId: "p",
    model: "m",
    turns: [turn("first"), turn("later")],
    createdAt: 1,
    updatedAt: 1,
  };
  store.conversations.push(c);
  store.flush();
  const rpcCalls: any[] = [],
    calls: any[] = [];
  let beforeRpc: ((method: string) => Promise<void>) | undefined,
    count = 0;
  const engine: any = {
    store,
    environment: { kind: "local" },
    spaceRoot: dir,
    defaultWorkspace: workspace,
    options: {},
    intentionalStop: false,
    pendingSend: false,
    newTaskChecks: new Set(),
    safeguardModels: new Map(),
    startedModelEfforts: [],
    loaded: new Set(),
    threadLimits: new Map(),
    steers: new Map(),
    agentRoutes: new Map(),
    firstOutput: new Map(),
    routes: new Map(),
    notificationTimer: new Map(),
    elsewhereFor: () => undefined,
    modelEfforts: () => [],
    changed() {
      store.flush();
    },
    emit() {},
    assertMcpAvailable() {},
    policy: () => ({ webSearch: false, incognito: false }),
    assertModel: (p: any, m: string) => assert.equal(m, p.model),
    sendCwd: () => workspace,
    canQueue: () => false,
    ensure: async (_p: any, o: any) => {
      if (o?.current && !o.current()) throw Error("Retired");
    },
    syncRequestOptions: async () => {},
    windowsSandbox: { ensureReady: async () => {} },
    sandboxSetupFolder: () => workspace,
    threadOptions: () => ({
      config: {},
      developerInstructions: "",
      model: "m",
    }),
    ensureThread: async (_c: any, _o: any, current: any) => {
      if (current && !current()) throw Error("Retired");
    },
    turnContext: (conversation: any) => ({ conversation }),
    turnExtras: () => ({}),
    refusalText: (_t: any, m: any) => m,
    clearApprovals() {},
    signals: { reported() {} },
    pendingPatches: { apply() {} },
    extensions: {
      list: () => [],
      beforeSend() {},
      prepareTurn: async () => {},
      recordItem: (_c: any, item: any) => item,
    },
  };
  for (const [name, fn] of Object.entries({
    send,
    retryResponse,
    selectPromptVersion,
    selectReplyVersion,
    selectChatLeaf,
    branchFrom,
    dropWebSearch,
    assertIncognitoLive,
    assertSendable,
    assertPolicy,
    assertIdle,
    assertExtensions,
    applyTurnEvent,
    applyItemEvent,
    recordOutputFiles,
  }))
    engine[name] = (...a: any[]) => (fn as Function).apply(engine, a);
  engine.rpc = {
    connected: true,
    call: async (method: string, args: any) => {
      assert.ok(["thread/start", "thread/fork", "turn/start"].includes(method));
      rpcCalls.push([method, structuredClone(args)]);
      await beforeRpc?.(method);
      if (method !== "turn/start") {
        if (mode === "branch-rejected")
          throw Error("Synthetic branch rejected");
        return { thread: { id: "new-thread-" + ++count } };
      }
      if (mode === "turn-rejected")
        throw Error("Synthetic turn/start unknown after branch commit");
      const pending = c.turns.at(-1);
      assert.equal(pending.status, "inProgress");
      const id = "regenerated-" + ++count;
      engine.applyTurnEvent(c, pending, "turn/started", {
        threadId: c.threadId,
        turn: { id },
      });
      engine.applyTurnEvent(c, pending, "item/completed", {
        threadId: c.threadId,
        item: {
          id: id + "-answer",
          type: "agentMessage",
          text: "Self-authored regenerated " + count,
        },
      });
      engine.applyTurnEvent(c, pending, "turn/completed", {
        threadId: c.threadId,
        turn: { id, status: "completed", stopReason: "end_turn" },
      });
      store.flush();
      return { turn: { id } };
    },
  };
  const context: any = {
    store,
    engine,
    activeAccount: { id: "synthetic" },
    accountActivationIdentity: identity,
    accountRetiring: false,
    selectedAttachments: new Map(),
    push() {},
    allowedFolder() {},
  };
  const handlers = new Map<string, Function>();
  registerConversationTurnHandlers({
    context,
    handle: (name: string, fn: Function) => handlers.set(name, fn),
    cli: {},
    resumable: {},
  } as any);
  const ctx: any = {
    account: () => ({ id: "synthetic" }),
    sessionIdentity: () => context.accountActivationIdentity,
    isCurrent: () => context.accountActivationIdentity === identity,
    settings: () => store.settings,
    modelCatalog: () => [],
    loadConversation: async () => structuredClone(c),
    call: async (name: string, ...args: any[]) => {
      calls.push([name, ...args]);
      assert.ok(handlers.has(name));
      return handlers.get(name)!(...args);
    },
    log() {},
  };
  return {
    dir,
    store,
    c,
    engine,
    ctx,
    context,
    calls,
    rpcCalls,
    handlers,
    hold(fn: (method: string) => Promise<void>) {
      beforeRpc = fn;
    },
    run: (target = "first") =>
      handlers.get("retryResponse")!("source", target, "p", "m"),
    close() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
const retryRequest = () =>
  deepCreate(input, {
    header: { conversationId: "source", existingOnly: true, mutationId: mark },
    action: {
      case: "sendMessage",
      value: {
        assistantMessageId: "new-assistant",
        inputMode: 2,
        parentMessageId: "first:user",
      },
    },
  });
const refresh = (f: any) => conversationUpdate(f.c, false);
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => (resolve = r)),
    resolve: () => resolve(),
  };
}
async function until(p: () => boolean) {
  for (let i = 0; i < 30 && !p(); i++)
    await new Promise((r) => setImmediate(r));
  assert.equal(p(), true);
}
test("original RETRY refusal settles its assistant stub and produces the original non-retryable notice contract before a buffered snapshot", async (t) => {
  for (const mode of ["host-throw", "unconfirmed"])
    await inAdapterScope(newAdapterScope("f006"), async () => {
      const o = original(t);
      if (!o) return;
      const f = fixture();
      try {
        refresh(f);
        const before = structuredClone(f.c);
        let calls = 0;
        f.ctx.call = async () => {
          calls++;
          if (mode === "host-throw") throw Error("Synthetic refusal");
          return undefined;
        };
        const req = o.request();
        assert.equal(req.action.value.messageId, "");
        const ack = await invoke(f.ctx, req);
        assert.equal(ack.outcome.case, "error");
        assert.equal(ack.outcome.value.action, "send_message");
        assert.equal(ack.outcome.value.messageId, "");
        assert.equal(ack.highWaterMark.version, 1n);
        assert.equal(ack.outcome.value.error.retryable, false);
        assert.equal(o.receive(ack)[0].foreign, false);
        o.receive(ack);
        assert.equal(o.gate.overlay.messages.size, 0);
        assert.equal(o.gate.retryStubByVersion.size, 0);
        assert.equal(o.rendered.length, 1);
        assert.equal(o.rendered[0].kind, "regeneration");
        assert.equal(o.rendered[0].retryable, false);
        assert.equal(
          o.rendered[0].displayMessage,
          ack.outcome.value.error.displayMessage,
        );
        assert.equal(calls, 1);
        assert.deepEqual(f.c, before);
      } finally {
        f.close();
      }
    });
});
test("actual send regenerates the selected first reply and restores both complete branches through actual API leaf selection", async () =>
  inAdapterScope(newAdapterScope("f006"), async () => {
    const f = fixture();
    try {
      const before = structuredClone(f.c);
      refresh(f);
      const ack = await invoke(f.ctx, retryRequest());
      assert.equal(ack.outcome.case, "applied");
      assert.equal(f.rpcCalls.filter((x) => x[0] === "turn/start").length, 1);
      assert.equal(f.c.turns.length, 1);
      const created = structuredClone(f.c.turns[0]);
      assert.notEqual(created.id, "first");
      assert.equal(created.prompt, before.turns[0].prompt);
      assert.equal(created.responseGroupId, before.turns[0].responseGroupId);
      assert.deepEqual(f.c.savedBranches[0].turns, before.turns);
      refresh(f);
      const leaf = (id: string) =>
        deepCreate(input, {
          header: {
            conversationId: "source",
            mutationId: { ...mark, version: 2n },
          },
          action: {
            case: "setCurrentLeaf",
            value: { currentLeafMessageId: id },
          },
        });
      assert.equal(
        (await invoke(f.ctx, leaf("later:assistant"))).outcome.case,
        "applied",
      );
      assert.deepEqual(f.c.turns, before.turns);
      refresh(f);
      assert.equal(
        (await invoke(f.ctx, leaf("new-assistant"))).outcome.case,
        "applied",
      );
      assert.equal(f.c.turns[0].id, created.id);
      const reopened = new Store(f.dir);
      assert.deepEqual(
        reopened.conversation("source").turns,
        JSON.parse(JSON.stringify(f.c.turns)),
      );
      assert.deepEqual(
        reopened.conversation("source").savedBranches,
        JSON.parse(JSON.stringify(f.c.savedBranches)),
      );
    } finally {
      f.close();
    }
  }));
test("failure before branch commit preserves the source transcript and never starts a turn", async () =>
  inAdapterScope(newAdapterScope("f006"), async () => {
    const f = fixture("branch-rejected");
    try {
      const before = structuredClone(f.c);
      refresh(f);
      const ack = await invoke(f.ctx, retryRequest());
      assert.equal(ack.outcome.case, "error");
      assert.equal(ack.outcome.value.error.retryable, false);
      assert.equal(f.rpcCalls.length, 1);
      assert.equal(f.rpcCalls[0][0], "thread/start");
      assert.deepEqual(f.c, before);
      assert.equal(f.engine.pendingSend, false);
      assert.deepEqual(new Store(f.dir).conversation("source"), before);
    } finally {
      f.close();
    }
  }));
test("failure after branch commit retains the original complete history and one failed attempt, never replays", async () =>
  inAdapterScope(newAdapterScope("f006"), async () => {
    const f = fixture("turn-rejected");
    try {
      const before = structuredClone(f.c);
      refresh(f);
      const ack = await invoke(f.ctx, retryRequest());
      assert.equal(ack.outcome.case, "error");
      assert.equal(ack.outcome.value.error.retryable, false);
      assert.deepEqual(f.c.savedBranches[0].turns, before.turns);
      assert.equal(f.c.turns.length, 1);
      assert.equal(f.c.turns[0].status, "failed");
      assert.equal(f.c.turns[0].sendFailed, true);
      assert.equal(f.rpcCalls.filter((x) => x[0] === "turn/start").length, 1);
      assert.equal(f.engine.pendingSend, false);
      const reopened = new Store(f.dir);
      assert.deepEqual(
        reopened.conversation("source").savedBranches[0].turns,
        before.turns,
      );
      assert.equal(reopened.conversation("source").turns[0].status, "failed");
      f.handlers.get("selectReplyVersion")!("source", f.c.turns[0].id, "first");
      assert.deepEqual(f.c.turns, before.turns);
    } finally {
      f.close();
    }
  }));
test("pending-send concurrency and active-turn guards reject regeneration/version switching without a second dispatch", async () => {
  const f = fixture(),
    gate = deferred();
  try {
    f.hold(async (method) => {
      if (method === "thread/start") await gate.promise;
    });
    const first = f.run();
    await until(() => f.rpcCalls.length === 1);
    assert.equal(f.engine.pendingSend, true);
    await assert.rejects(f.run(), /being created/);
    assert.throws(
      () =>
        f.handlers.get("selectReplyVersion")!("source", "first", "unrelated"),
      /submission/,
    );
    assert.equal(f.rpcCalls.length, 1);
    gate.resolve();
    await first;
    assert.equal(f.engine.pendingSend, false);
    f.c.turns[0].status = "inProgress";
    const count = f.rpcCalls.length;
    await assert.rejects(f.run(f.c.turns[0].id), /still running/);
    assert.throws(
      () =>
        f.handlers.get("selectReplyVersion")!(
          "source",
          f.c.turns[0].id,
          "first",
        ),
      /current response/,
    );
    assert.equal(f.rpcCalls.length, count);
  } finally {
    gate.resolve();
    f.close();
  }
});
test("stale, unknown and foreign RETRY targets settle only their original stub without dispatch", async (t) => {
  for (const kind of ["deleted", "unknown", "foreign", "inactive"])
    await inAdapterScope(newAdapterScope("f006"), async () => {
      const o = original(t);
      if (!o) return;
      const f = fixture();
      try {
        refresh(f);
        const req = o.request();
        if (kind === "deleted") f.c.turns = [];
        if (kind === "unknown") req.action.value.parentMessageId = "missing";
        if (kind === "foreign") {
          conversationUpdate(
            {
              ...f.c,
              id: "foreign",
              turns: [{ ...f.c.turns[0], id: "foreign-turn" }],
            },
            false,
          );
          req.action.value.parentMessageId = "foreign-turn:user";
        }
        if (kind === "inactive") {
          f.c.savedBranches = [
            {
              id: "saved",
              threadId: "saved-thread",
              turns: [{ ...f.c.turns[0], id: "old-first" }],
              savedAt: 1,
            },
          ];
          refresh(f);
          req.action.value.parentMessageId = "old-first:user";
        }
        const before = JSON.stringify(f.c),
          ack = await invoke(f.ctx, req);
        assert.equal(ack.outcome.case, "error");
        assert.equal(ack.highWaterMark.version, 1n);
        assert.equal(ack.outcome.value.action, "send_message");
        assert.equal(ack.outcome.value.messageId, "");
        assert.equal(ack.outcome.value.error.retryable, false);
        o.receive(ack);
        assert.equal(o.gate.overlay.messages.size, 0);
        assert.equal(o.gate.retryStubByVersion.size, 0);
        assert.equal(o.rendered.length, 1);
        assert.equal(f.calls.length, 0);
        assert.equal(f.rpcCalls.length, 0);
        assert.equal(JSON.stringify(f.c), before);
      } finally {
        f.close();
      }
    });
});
test("ordinary sends and malformed retry identities retain existing refusal classification", async () =>
  inAdapterScope(newAdapterScope("f006"), async () => {
    for (const kind of ["append", "human", "assistant", "parent"]) {
      const f = fixture();
      try {
        refresh(f);
        const req = retryRequest();
        req.action.value.parentMessageId = "missing";
        if (kind === "append") req.action.value.inputMode = 0;
        if (kind === "human") req.action.value.messageId = "new-human";
        if (kind === "assistant") req.action.value.assistantMessageId = "";
        if (kind === "parent") req.action.value.parentMessageId = "";
        const ack = await invoke(f.ctx, req);
        assert.equal(ack.outcome.case, "error");
        assert.equal(ack.highWaterMark, undefined);
        assert.equal(ack.outcome.value.action, "sendMessage");
        assert.equal(f.calls.length, 0);
        assert.equal(f.rpcCalls.length, 0);
      } finally {
        f.close();
      }
    }
  }));
