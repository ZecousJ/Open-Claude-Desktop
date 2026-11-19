import { beforeF014Stop } from "./support/f014-resource-chain.mjs";
import {
  regenerationErrorAfter,
  regenerationErrorBefore,
  regenerationErrorInput,
  regenerationErrorTarget,
  deriveOfficialRegenerationErrorModule,
} from "../scripts/official-ui-regeneration-error.mjs";
import {
  editRetryHubBefore,
  editRetryHubAfter,
  deriveOfficialEditRetryModule,
  editRetryHub,
} from "../scripts/official-ui-edit-retry.mjs";
/** Actual API/codec/original failure methods. Synthetic data; no provider or SDK execution. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import ts from "typescript";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  createActionRpc,
  PERFORM_ACTION_PATH,
} from "../electron/official-ui/api/actions";
import {
  loadRegistry,
  deepCreate,
  conversationUpdate,
} from "../electron/official-ui/api/timeline";
import {
  newAdapterScope,
  inAdapterScope,
} from "../electron/official-ui/api/scope";
import {
  conversationAliases,
  conversationRestMessages,
} from "../electron/official-ui/api/conversations";
import { Store } from "../electron/store/store";
import { registerConversationTurnHandlers } from "../electron/ipc/conversation-turn-handlers";
import {
  editPrompt,
  selectChatLeaf,
  selectPromptVersion,
  selectReplyVersion,
} from "../electron/engine/engine-send";
import { branchFrom } from "../electron/engine/engine-turn-setup";
const registry = loadRegistry(
    "build/official-ui/data/conversation-protocol.json",
  ),
  input = registry.getMessage(
    "anthropic.bard.api.v1alpha.PerformActionRequest",
  )!,
  output = registry.getMessage(
    "anthropic.bard.api.v1alpha.PerformActionResponse",
  )!,
  mark = { sessionId: "f008-self", version: 1n };
function original(t: any) {
  const file =
    "build/official-ui/ui/assets/v1/30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js";
  if (!fs.existsSync(file)) {
    t.skip("Original pinned hub resource required for consumer comparison");
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
  // The newer pinned F008 projection does not change the methods below. Reverse
  // only its exact full output in memory, then retain the original hash check.
  if (
    createHash("sha256").update(source).digest("hex") ===
    "afc1d3758e53500d00ddc331375621b68bc6c5f100bffa2afbb1a1dd9294a830"
  ) {
    const final = source;
    assert.equal(source.split(editRetryHubAfter).length, 2);
    source = source.replace(editRetryHubAfter, editRetryHubBefore);
    assert.equal(deriveOfficialEditRetryModule(editRetryHub, source), final);
  }
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "b845ebfc11728c5bdac1b63ab3a4f03d54948715cc7649433efd1eb2b8d4ab14",
  );
  const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
    vars = new Map<string, ts.VariableDeclaration>();
  for (const stmt of ast.statements)
    if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations)
        if (ts.isIdentifier(d.name)) vars.set(d.name.text, d);
  const cls = vars.get("U$")!.initializer as ts.ClassExpression,
    methods = [
      "ownsSession",
      "ownsMark",
      "foreignSeenOnce",
      "settleError",
      "reperformedSince",
      "withdrawGiveUp",
    ].map((name) =>
      cls.members
        .find(
          (m) => ts.isMethodDeclaration(m) && m.name?.getText(ast) === name,
        )!
        .getText(ast),
    );
  let arrow: ts.ArrowFunction | undefined;
  function visit(n: ts.Node) {
    if (
      ts.isArrowFunction(n) &&
      n.getText(ast) ===
        '(e) => e.action === "send_message" || (e.action === "" && e.messageId !== "")'
    )
      arrow = n;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(arrow);
  const methodsValue = vm.runInNewContext(`({${methods.join(",")}})`, {
      e: { FOREIGN_SEEN_CAP: 100 },
      Y: { USER: 1 },
    }),
    isSend = vm.runInNewContext("(" + arrow.getText(ast) + ")");
  return (ack: any) => {
    const authoritative = new Map();
    const gate: any = {
      ...methodsValue,
      session: { ownedSessionIds: new Set([mark.sessionId]) },
      floorVersion: 0n,
      latestVersion: 1n,
      foreignSeen: new Set(),
      pendingFailures: [],
      failedVersions: new Map(),
      retryStubByVersion: new Map(),
      sentByVersion: new Map(),
      performedBy: new Map(),
      overlay: { messages: new Map() },
      shadow: { hasRowFor: (id: string) => authoritative.has(id) },
    };
    gate.settleError(ack.highWaterMark, ack.outcome.value);
    return {
      foreign: gate.pendingFailures[0]?.foreign,
      version: gate.pendingFailures[0]?.version,
      recognizedSend: isSend(ack.outcome.value),
    };
  };
}
function fixture(options: any = {}) {
  const identity = {},
    calls: any[] = [];
  const c: any = {
      id: "c",
      mode: "chat",
      providerId: "p",
      model: "m",
      createdAt: 1,
      updatedAt: 1,
      turns: ["first", "later"].map((id, i) => ({
        id,
        prompt: "Synthetic " + id,
        attachments: [],
        items: [],
        status: "completed",
        createdAt: i + 1,
      })),
    },
    scope = newAdapterScope("f008-self");
  const ctx: any = {
    account: () => ({ id: "f008-self" }),
    sessionIdentity: () => identity,
    isCurrent: () => true,
    settings: () => ({
      providers: [{ id: "p", backend: "sub2api", model: "m" }],
    }),
    modelCatalog: () => [],
    loadConversation: async () => {
      if (options.readFailure) throw Error("Synthetic read failure");
      return options.missing ? undefined : c;
    },
    call: async (name: string, ...args: any[]) => {
      calls.push([name, ...args]);
      if (options.fail) throw Error("Synthetic host rejection");
      if (options.unconfirmed) return;
      return { ...c, turns: [...c.turns, { ...c.turns[0], id: "new-turn" }] };
    },
    log() {},
  };
  inAdapterScope(scope, () => {
    conversationAliases.restore("page", "c");
    conversationUpdate(c, false);
  });
  return { ctx, scope, c, calls };
}
async function invoke(f: any, value: any, options: any = {}) {
  const req: any = Readable.from([
    Buffer.from(
      toBinary(
        input,
        deepCreate(input, {
          header: {
            conversationId: "page",
            existingOnly: true,
            ...(options.noMark ? {} : { mutationId: mark }),
          },
          action: {
            case: options.action ?? "sendMessage",
            value: options.action
              ? value
              : {
                  messageId: "new-human",
                  assistantMessageId: "new-assistant",
                  ...value,
                },
          },
        }),
      ),
    ),
  ]);
  req.method = "POST";
  req.headers = { "content-type": "application/proto" };
  let body: Buffer | undefined;
  const res: any = {
    writeHead(status: number) {
      assert.equal(status, 200);
    },
    end(b: Buffer) {
      body = Buffer.from(b);
    },
  };
  await inAdapterScope(f.scope, () =>
    createActionRpc(f.ctx, registry)(req, res, PERFORM_ACTION_PATH),
  );
  return (fromBinary(output, body!) as any).ack;
}
test("resolved first and earlier edit refusals correlate to the original send consumer", async (t) => {
  const consume = original(t);
  if (!consume) return;
  for (const parent of ["", "first:assistant"])
    for (const kind of ["empty", "host", "unknown"]) {
      const f = fixture({
          fail: kind === "host",
          unconfirmed: kind === "unknown",
        }),
        ack = await invoke(f, {
          parentMessageId: parent,
          text: kind === "empty" ? "" : "Edited 中文",
        });
      assert.equal(ack.outcome.case, "error");
      assert.equal(ack.outcome.value.action, "send_message");
      assert.equal(ack.outcome.value.messageId, "new-human");
      assert.equal(ack.outcome.value.error.retryable, false);
      assert.deepEqual(consume(ack), {
        foreign: false,
        version: 1n,
        recognizedSend: true,
      });
      assert.equal(f.calls.length, kind === "empty" ? 0 : 1);
      if (kind !== "empty") assert.equal(f.calls[0][0], "editPrompt");
      if (kind === "unknown")
        assert.match(
          ack.outcome.value.error.displayMessage,
          /could not be confirmed.*Reopen/,
        );
    }
});
test("append refusals retain published receipt association while unresolved edits and legacy retries remain unchanged", async () => {
  for (const value of [
    { text: "append" },
    { parentMessageId: "later:assistant", text: "followup" },
  ]) {
    const f = fixture({ fail: true }),
      ack = await invoke(f, value);
    assert.equal(ack.outcome.case, "error");
    assert.equal(ack.highWaterMark.sessionId, mark.sessionId);
    assert.equal(ack.highWaterMark.version, mark.version);
    assert.equal(ack.outcome.value.action, "send_message");
    assert.equal(ack.outcome.value.messageId, "new-human");
    assert.equal(ack.outcome.value.error.retryable, false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], "send");
  }
  for (const value of [
    { parentMessageId: "first:user", inputMode: 2 },
    { parentMessageId: "unknown", text: "edit" },
    { parentMessageId: "first:user", text: "edit" },
  ]) {
    const f = fixture({ fail: true }),
      ack = await invoke(f, value);
    assert.equal(ack.outcome.case, "error");
    assert.equal(ack.highWaterMark, undefined);
    assert.equal(ack.outcome.value.action, "sendMessage");
    assert.equal(ack.outcome.value.messageId, "");
  }
  for (const options of [{ missing: true }, { readFailure: true }]) {
    const f = fixture(options),
      ack = await invoke(f, { parentMessageId: "", text: "edit" });
    assert.equal(ack.highWaterMark, undefined);
    assert.equal(ack.outcome.value.action, "sendMessage");
    assert.equal(f.calls.length, 0);
  }
});
test("no mutation mark is invented and successful edit/append ACKs remain unchanged", async () => {
  const f = fixture({ fail: true }),
    ack = await invoke(
      f,
      { parentMessageId: "", text: "edit" },
      { noMark: true },
    );
  assert.equal(ack.highWaterMark, undefined);
  assert.equal(ack.outcome.value.messageId, "new-human");
  for (const value of [
    { parentMessageId: "", text: "edit" },
    { parentMessageId: "first:assistant", text: "edit later" },
    { parentMessageId: "later:assistant", text: "followup" },
  ]) {
    const g = fixture(),
      ok = await invoke(g, value);
    assert.equal(ok.outcome.case, "applied");
    assert.equal(ok.highWaterMark.sessionId, mark.sessionId);
    assert.equal(ok.highWaterMark.version, mark.version);
    assert.equal(
      g.calls[0][0],
      value.parentMessageId === "later:assistant" ? "send" : "editPrompt",
    );
  }
});
test("the same first-message edit mutation settles once without creating a second branch", async () => {
  const f = fixture();
  const edit = { parentMessageId: "", text: "Edited first" };
  const [first, replay] = await Promise.all([invoke(f, edit), invoke(f, edit)]);
  assert.equal(first.outcome.case, "applied");
  assert.deepEqual(replay, first);
  assert.equal(f.calls.length, 1);
  const conflicting = await invoke(f, { ...edit, text: "Different edit" });
  assert.equal(conflicting.outcome.case, "error");
  assert.equal(f.calls.length, 1);
});
test("actual branch methods preserve complete later continuation and restore it without another generated reply", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f008-branch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root),
    f = fixture();
  store.conversations.push(f.c);
  store.flush();
  let sends = 0;
  const rpcCalls: any[] = [];
  const engine: any = {
    store,
    pendingSend: false,
    elsewhereFor: () => undefined,
    modelEfforts: () => [],
    rpc: {
      call: async (name: string, args: any) => {
        rpcCalls.push([name, args]);
        assert.equal(name, "thread/start");
        return { thread: { id: "synthetic-new-thread" } };
      },
    },
    loaded: new Set(),
    threadLimits: new Map(),
    routes: new Map(),
    notificationTimer: new Map(),
    emit() {},
    changed() {},
    send: async (input: any, target: string, editing: boolean, lease: any) => {
      assert.equal(lease.current(), true);
      sends++;
      const c = store.conversation("c"),
        versions = await branchFrom.call(
          engine,
          c,
          target,
          editing,
          { config: {} } as any,
          lease.current,
        );
      c.turns.push({
        id: "edited-turn",
        prompt: input.text,
        attachments: input.attachments,
        items: [],
        status: "completed",
        createdAt: 3,
        ...versions,
      });
      store.flush();
      return structuredClone(c);
    },
  };
  engine.editPrompt = (...args: any[]) => editPrompt.apply(engine, args as any);
  engine.selectChatLeaf = (...args: any[]) => selectChatLeaf.apply(engine, args as any);
  engine.selectPromptVersion = (...args: any[]) =>
    selectPromptVersion.apply(engine, args as any);
  engine.selectReplyVersion = (...args: any[]) =>
    selectReplyVersion.apply(engine, args as any);
  const handlers = new Map<string, Function>();
  registerConversationTurnHandlers({
    handle: (name: string, fn: Function) => handlers.set(name, fn),
    context: {
      store,
      engine,
      selectedAttachments: new Map(),
      allowedFolder() {},
      accountActivationIdentity: {},
      accountRetiring: false,
      activeAccount: { id: "f008-self" },
    },
    cli: {},
    resumable: {},
  } as any);
  f.ctx.loadConversation = async () => structuredClone(store.conversation("c"));
  f.ctx.call = async (name: string, ...args: any[]) =>
    handlers.get(name)!(...args);
  const edited = await invoke(f, {
    parentMessageId: "",
    text: "Edited first 中文",
  });
  assert.equal(
    edited.outcome.case,
    "applied",
    JSON.stringify(edited, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
  );
  let c = store.conversation("c");
  assert.deepEqual(
    c.turns.map((x) => x.prompt),
    ["Edited first 中文"],
  );
  assert.deepEqual(
    c.savedBranches![0].turns.map((x) => x.prompt),
    ["Synthetic first", "Synthetic later"],
  );
  assert.equal(sends, 1);
  await inAdapterScope(f.scope, async () => {
    const pb = conversationUpdate(c, false),
      rest = conversationRestMessages(c);
    assert.ok(pb.messages);
    assert.equal(pb.messages.length, 6);
    assert.equal(rest.messages.length, 6);
    assert.ok(pb.messages.some((x) => x.id === "later:assistant"));
  });
  const inactive = await invoke(f, {
    parentMessageId: "later:assistant",
    text: "must not append",
  });
  assert.equal(inactive.outcome.case, "error");
  assert.equal(sends, 1);
  const restored = await invoke(
    f,
    { currentLeafMessageId: "later:assistant" },
    { action: "setCurrentLeaf" },
  );
  assert.equal(restored.outcome.case, "applied");
  assert.equal(sends, 1);
  c = store.conversation("c");
  assert.deepEqual(
    c.turns.map((x) => x.prompt),
    ["Synthetic first", "Synthetic later"],
  );
  assert.equal(
    c.savedBranches!.some((b) => b.turns[0].prompt === "Edited first 中文"),
    true,
  );
  const reopened = new Store(root).conversation("c");
  assert.deepEqual(
    reopened.turns.map((x) => x.prompt),
    ["Synthetic first", "Synthetic later"],
  );
  assert.equal(
    reopened.savedBranches!.some(
      (b) => b.turns[0].prompt === "Edited first 中文",
    ),
    true,
  );
  assert.equal(rpcCalls.length, 1);
});
