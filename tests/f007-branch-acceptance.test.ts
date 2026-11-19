import { beforeF014Stop } from "./support/f014-resource-chain.mjs";
import {
  regenerationErrorAfter,
  regenerationErrorBefore,
  regenerationErrorInput,
  regenerationErrorTarget,
  deriveOfficialRegenerationErrorModule,
} from "../scripts/official-ui-regeneration-error.mjs";
/** Real Store/registered fork handler and original protocol functions; no SDK, model, or tool execution. */
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
  process.env.F007_SOURCE_ROOT ?? path.resolve(import.meta.dirname, "..");
const assets =
  process.env.F007_ASSETS_ROOT ?? path.join(root, "build/official-ui");
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
const { messageIndex, conversationAliases, conversationRestMessages } =
  await mod("electron/official-ui/api/conversations.ts");
const { Store } = await mod("electron/store/store.ts");
const { registerComposerHandlers } = await mod("electron/ipc/composer.ts");
const { forkConversation } = await mod("electron/engine/engine-history.ts");
const registry = loadRegistry(
  path.join(assets, "data/conversation-protocol.json"),
);
const input = registry.getMessage(
  "anthropic.bard.api.v1alpha.PerformActionRequest",
)!;
const output = registry.getMessage(
  "anthropic.bard.api.v1alpha.PerformActionResponse",
)!;
const destination = "00000000-0000-4000-8000-000000000007";
const mark = { sessionId: "f007-self", version: 1n };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function original(t: any) {
  const file = path.join(
    assets,
    "ui/assets/v1/30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js",
  );
  if (!fs.existsSync(file)) {
    t.skip("Pinned original resource required for original-consumer contract");
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
  assert.ok(
    [
      "b845ebfc11728c5bdac1b63ab3a4f03d54948715cc7649433efd1eb2b8d4ab14",
      "afc1d3758e53500d00ddc331375621b68bc6c5f100bffa2afbb1a1dd9294a830",
    ].includes(sha(source)),
  );
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let cls: any, gn: any, branch: any;
  function visit(n: ts.Node) {
    if (ts.isVariableDeclaration(n) && n.name.getText(ast) === "U$")
      cls = n.initializer;
    if (
      ts.isVariableDeclaration(n) &&
      n.name.getText(ast) === "gn" &&
      n.initializer?.getText(ast).includes("R.pendingBranchCopies.get(e)")
    )
      gn = n.initializer;
    if (
      ts.isIfStatement(n) &&
      n.expression.getText(ast) === "o.failure.action === aue"
    )
      branch = n;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(cls && gn && branch);
  const methods = [
    "ownsSession",
    "ownsMark",
    "foreignSeenOnce",
    "settleError",
    "disposeFailures",
    "isSuperseded",
    "drainFailureNotices",
  ].map((name) =>
    cls.members
      .find(
        (m: any) => ts.isMethodDeclaration(m) && m.name.getText(ast) === name,
      )
      .getText(ast),
  );
  const original = vm.runInNewContext(`({${methods.join(",")}})`, {
    e: { FOREIGN_SEEN_CAP: 100 },
    Y: { USER: 1 },
    pv: new Set(),
  });
  const settled: any[] = [];
  const R = {
    pendingBranchCopies: new Map([[1n, (x: any) => settled.push(x)]]),
  };
  const drain = vm.runInNewContext(
    `(notices)=>{const gn=${gn.getText(ast)};for(const o of notices){${branch.getText(ast)}}}`,
    { R, aue: "continue_branch_as_new_chat" },
  );
  const gate: any = {
    ...original,
    session: { ownedSessionIds: new Set([mark.sessionId]) },
    floorVersion: 0n,
    latestVersion: 1n,
    foreignSeen: new Set(),
    pendingFailures: [],
    failedVersions: new Map(),
    retryStubByVersion: new Map(),
    sentByVersion: new Map(),
    overlay: { messages: new Map() },
    markedByVersion: new Map(),
    noticeQueue: [],
    shadow: { hasRowFor: () => false },
  };
  return {
    settled,
    R,
    receive(ack: any) {
      gate.settleError(ack.highWaterMark, ack.outcome.value);
      const pending = gate.pendingFailures;
      gate.pendingFailures = [];
      gate.disposeFailures(pending);
      drain(gate.drainFailureNotices());
      return pending;
    },
  };
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f007-inert-"));
  const store = new Store(dir);
  const provider = { id: "p-old", model: "m-old" },
    liveProvider = { id: "p-live", model: "m-live" };
  store.settings = { ...store.settings, providers: [provider, liveProvider] };
  const turn = (id: string) => ({
    id,
    prompt: "Self-authored " + id,
    status: "completed",
    createdAt: 1,
    attachments: [],
    items: [{ id: id + "-text", type: "agentMessage", text: "Recorded " + id }],
  });
  const first: any = turn("saved-first"),
    second: any = turn("saved-second"),
    tail: any = turn("saved-tail");
  first.attachments = [
    {
      id: "self-file",
      name: "历史资料.txt",
      path: path.join(dir, "recorded-only.txt"),
      kind: "text",
      size: 17,
    },
  ];
  second.items.unshift(
    {
      id: "cmd",
      type: "commandExecution",
      command: "synthetic recorded command",
      cwd: "/synthetic-record-only",
      aggregatedOutput: "Recorded output 中文",
      exitCode: 0,
      status: "completed",
      lifecycleStatus: "completed",
    },
    {
      id: "dynamic",
      type: "dynamicToolCall",
      tool: "synthetic.record",
      arguments: { steps: [{ label: "甲" }, { label: "乙" }] },
      contentItems: [
        { type: "inputText", text: "Recorded result 🧪" },
        { type: "inputText", text: "Second part" },
      ],
      success: true,
      status: "completed",
      lifecycleStatus: "completed",
    },
  );
  const source: any = {
    id: "source",
    title: "Self-authored source",
    mode: "chat",
    providerId: liveProvider.id,
    model: liveProvider.model,
    threadId: "live-thread",
    activeBranchId: "live",
    turns: [turn("live")],
    savedBranches: [
      {
        id: "saved",
        threadId: "old-thread",
        providerId: provider.id,
        model: provider.model,
        turns: [first, second, tail],
        visited: 0,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
  store.conversations.push(source);
  store.flush();
  const calls: any[] = [];
  let active = true;
  const identity = {};
  const engine: any = {
    store,
    pendingSend: false,
    intentionalStop: false,
    elsewhereFor: () => undefined,
    assertModel: (p: any, m: string) => assert.equal(p.model, m),
    policy: () => ({}),
    ensure: async () => {},
    ensureThread: async () => {},
    threadOptions: () => ({ config: {}, developerInstructions: "" }),
    loaded: new Set(),
    threadLimits: new Map(),
    routes: new Map(),
    changed() {},
    send() {
      throw Error("No model or send allowed");
    },
    rpc: {
      call: async (name: string, args: any) => {
        calls.push([name, args]);
        assert.equal(name, "thread/fork");
        return { thread: { id: "fork-thread" } };
      },
    },
  };
  engine.forkConversation = (...a: any[]) => forkConversation.apply(engine, a);
  const context: any = {
    store,
    engine,
    activeAccount: { id: "synthetic" },
    accountActivationIdentity: identity,
    accountRetiring: false,
  };
  const handlers = new Map<string, Function>();
  registerComposerHandlers(
    (name: string, fn: Function) => handlers.set(name, fn),
    context,
  );
  const ctx: any = {
    account: () => ({ id: "synthetic" }),
    sessionIdentity: () => identity,
    isCurrent: () => active,
    loadConversation: async (id: string) =>
      store.conversations.find((c: any) => c.id === id),
    call: async (name: string, ...a: any[]) => {
      assert.equal(name, "forkConversation");
      return handlers.get(name)!(...a);
    },
    log() {},
  };
  return {
    dir,
    store,
    source,
    engine,
    ctx,
    context,
    calls,
    retire() {
      active = false;
      context.accountActivationIdentity = {};
    },
    close() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
    run: () =>
      handlers.get("forkConversation")!("source", {
        turnId: "saved-second",
        branchId: "saved",
      }),
  };
}
async function request(
  ctx: any,
  through = "saved-second:assistant",
  action = "continueBranchAsNewChat",
) {
  messageIndex.set(
    "source",
    new Map([
      [
        "saved-second:assistant",
        {
          turnId: "saved-second",
          kind: "assistant",
          branchId: "saved",
          active: false,
        },
      ],
      [
        "saved-first:user",
        {
          turnId: "saved-first",
          kind: "user",
          branchId: "saved",
          active: false,
        },
      ],
    ]),
  );
  const message = deepCreate(input, {
    header: { conversationId: destination, mutationId: mark },
    action: {
      case: action,
      value: { sourceConversationId: "source", throughMessageId: through },
    },
  });
  const req: any = Readable.from([Buffer.from(toBinary(input, message))]);
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
test("branch refusals settle original pending copies once, with own mutation and no alias or retry", async (t) => {
  for (const kind of [
    "missing",
    "user",
    "host-throw",
    "missing-result",
    "same-source",
  ])
    await inAdapterScope(newAdapterScope("f007"), async () => {
      const consumer = original(t);
      if (!consumer) return;
      const f = fixture();
      try {
        let calls = 0;
        f.ctx.call = async () => {
          calls++;
          if (kind === "host-throw")
            throw Error("Private synthetic host detail");
          return kind === "missing-result" ? undefined : { id: "source" };
        };
        const ack = await request(
          f.ctx,
          kind === "missing"
            ? "unknown"
            : kind === "user"
              ? "saved-first:user"
              : undefined,
        );
        assert.equal(ack.outcome.case, "error");
        assert.equal(ack.outcome.value.action, "continue_branch_as_new_chat");
        assert.equal(ack.outcome.value.error.retryable, false);
        assert.equal(ack.highWaterMark.sessionId, mark.sessionId);
        assert.equal(ack.highWaterMark.version, mark.version);
        assert.doesNotMatch(ack.outcome.value.error.displayMessage, /Private/);
        assert.equal(consumer.receive(ack)[0].foreign, false);
        consumer.receive(ack);
        assert.equal(consumer.settled.length, 1);
        assert.equal(consumer.settled[0].kind, "refused");
        assert.equal(consumer.R.pendingBranchCopies.size, 0);
        assert.equal(calls, ["missing", "user"].includes(kind) ? 0 : 1);
        assert.equal(conversationAliases.has("source"), false);
        assert.equal(conversationAliases.has(destination), false);
      } finally {
        f.close();
      }
    });
});
test("real registered fork preserves exact saved prefix attachment/tool records and persists target, not active branch", async () =>
  inAdapterScope(newAdapterScope("f007"), async () => {
    const f = fixture();
    try {
      const before = structuredClone(f.source),
        ack = await request(f.ctx);
      assert.equal(ack.outcome.case, "applied");
      assert.equal(ack.highWaterMark.version, 1n);
      const id = destination;
      assert.equal(conversationAliases.has(destination), false);
      assert.equal(conversationAliases.has("source"), false);
      const target = f.store.conversation(id);
      assert.deepEqual(target.turns, before.savedBranches[0].turns.slice(0, 2));
      assert.equal(target.providerId, "p-old");
      assert.equal(target.model, "m-old");
      assert.equal(target.threadId, "fork-thread");
      assert.equal(target.savedBranches, undefined);
      assert.equal(target.forkedFrom.turnId, "saved-second");
      assert.deepEqual(
        { ...f.source, forks: undefined },
        { ...before, forks: undefined },
      );
      assert.equal(f.source.forks.length, 1);
      assert.equal(f.source.forks[0].conversationId, id);
      assert.deepEqual(f.calls, [
        [
          "thread/fork",
          {
            threadId: "old-thread",
            lastTurnId: "saved-second",
            config: {},
            developerInstructions: "",
          },
        ],
      ]);
      const reopened = new Store(f.dir);
      assert.deepEqual(reopened.conversation(id).turns, target.turns);
      assert.deepEqual(reopened.conversation("source").turns, before.turns);
      assert.deepEqual(
        reopened.conversation("source").savedBranches,
        before.savedBranches,
      );
      target.turns[0].attachments[0].name = "changed target only";
      assert.equal(
        f.source.savedBranches[0].turns[0].attachments[0].name,
        "历史资料.txt",
      );
    } finally {
      f.close();
    }
  }));
test("recorded fork content remains visible in the timeline without invoking tools", async () =>
  inAdapterScope(newAdapterScope("f007"), async () => {
    const f = fixture();
    try {
      const target = await f.run();
      assert.throws(() => conversationRestMessages(
        target,
        "00000000-0000-4000-8000-000000000007",
      ), { status: 501 });
      const pb = conversationUpdate(target, false, {
        org: "00000000-0000-4000-8000-000000000007",
      });
      assert.ok(
        JSON.stringify(pb, (_, v) =>
          typeof v === "bigint" ? String(v) : v,
        ).includes("Recorded output 中文"),
      );
      assert.ok(JSON.stringify(pb, (_, v) => typeof v === "bigint" ? String(v) : v).includes("历史资料.txt"));
      assert.equal(f.calls.length, 1);
    } finally {
      f.close();
    }
  }));
test("retirement and saved-branch races do not publish or retry an unknown dispatched fork", async () => {
  for (const mode of [
    "pre-account",
    "pre-branch",
    "post-account",
    "post-branch",
  ]) {
    const f = fixture();
    try {
      const before = structuredClone(f.source);
      const mutate = () =>
        mode.endsWith("account")
          ? f.retire()
          : (f.source.savedBranches[0].turns[0].prompt =
              "Concurrent recorded update");
      if (mode.startsWith("pre")) f.engine.ensure = async () => mutate();
      else
        f.engine.rpc.call = async (name: string, args: any) => {
          f.calls.push([name, args]);
          mutate();
          return { thread: { id: "possibly-created" } };
        };
      await assert.rejects(f.run(), /changed/);
      assert.equal(f.calls.length, mode.startsWith("pre") ? 0 : 1);
      assert.equal(f.store.conversations.length, 1);
      assert.equal(f.source.forks, undefined);
      assert.equal(f.engine.pendingSend, false);
      assert.deepEqual(f.source.turns, before.turns);
    } finally {
      f.close();
    }
  }
});
test("unknown, ambiguous, active, and foreign saved targets are rejected without dispatch", async () => {
  for (const kind of ["missing", "duplicate", "in-progress", "foreign-turn"]) {
    const f = fixture();
    try {
      if (kind === "missing") f.source.savedBranches = [];
      if (kind === "duplicate")
        f.source.savedBranches.push(structuredClone(f.source.savedBranches[0]));
      if (kind === "in-progress")
        f.source.savedBranches[0].turns[1].status = "inProgress";
      if (kind === "foreign-turn")
        f.source.savedBranches[0].turns[1].id = "other";
      await assert.rejects(f.run());
      assert.equal(f.calls.length, 0);
      assert.equal(f.store.conversations.length, 1);
      assert.equal(f.source.forks, undefined);
    } finally {
      f.close();
    }
  }
});
test("original copy continuation does not automatically retry a refused unknown result", async (t) => {
  const file = path.join(
    assets,
    "ui/assets/v1/f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js",
  );
  if (!fs.existsSync(file)) {
    t.skip(
      "Pinned original main resource required for original-copy continuation contract",
    );
    return;
  }
  const source = beforeF014Stop("f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js", fs.readFileSync(file, "utf8"));
  assert.equal(
    sha(source),
    "7956e1ad0c4f547e3a88b6fa427a786694cb3b8b8f1f60f87a435ed7bfadb6a4",
  );
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let retry: any;
  function visit(n: ts.Node) {
    if (
      ts.isVariableDeclaration(n) &&
      n.name.getText(ast) === "r" &&
      n.initializer
        ?.getText(ast)
        .includes(
          'i.kind === "abandoned" && !i.givenUp && a ? (R3.add(t), r(n(), !1)) : d(i)',
        )
    )
      retry = n.initializer;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(retry);
  let sends = 0;
  const settled: any[] = [];
  const run = vm.runInNewContext(
    `(outcome)=>{const r=${retry.getText(ast)};r(Promise.resolve(outcome),true);}`,
    {
      e: true,
      R3: new Set(),
      t: {},
      n: () => {
        sends++;
        return Promise.resolve({ kind: "applied" });
      },
      d: (x: any) => settled.push(x),
    },
  );
  run({
    kind: "refused",
    displayMessage:
      "The new chat could not be confirmed. Check your chats before retrying.",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].kind, "refused");
});
