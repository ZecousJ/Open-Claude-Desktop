/** Actual API/codec/Store and pinned original queue, with inert send terminals.
 * No provider, SDK, socket, account login, or model execution. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
  createActionRpc,
  PERFORM_ACTION_PATH,
} from "../electron/official-ui/api/actions";
import {
  registryFor,
  conversationUpdate,
} from "../electron/official-ui/api/timeline";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
import { loadConversationState } from "../electron/official-ui/api/conversations";
import { Store } from "../electron/store/store";

const assets = path.resolve(
  process.env.OFFICIAL_UI_ROOT ?? "build/official-ui",
);
const registry = registryFor(assets);
const requestSchema = registry.getMessage(
  "anthropic.bard.api.v1alpha.PerformActionRequest",
)!;
const responseSchema = registry.getMessage(
  "anthropic.bard.api.v1alpha.PerformActionResponse",
)!;
const mark = { sessionId: "f022-local-replay", version: 1n };
function fixture(
  t: any,
  options: {
    hold?: Promise<void>;
    fail?: boolean;
    commitThenFail?: boolean;
    durable?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f022-append-"));
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new Store(root),
    identity = {};
  let scope = newAdapterScope("f022-local", root, identity);
  const c: any = {
    id: "f022-conversation",
    mode: "chat",
    providerId: "p",
    model: "m",
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    activeBranchId: "main",
    turns: [
      {
        id: "context",
        prompt: "Self-authored context",
        attachments: [],
        items: [],
        createdAt: 1,
        status: "completed",
      },
    ],
  };
  store.conversations.push(c);
  store.flush();
  const calls: string[] = [];
  const ctx: any = {
    root: assets,
    account: () => ({ id: "f022-local" }),
    sessionIdentity: () => identity,
    isCurrent: () => true,
    stateDirectory: () => root,
    strictActionSemantics: true,
    settings: () => ({ providers: [{ id: "p", model: "m" }] }),
    modelCatalog: () => [],
    log() {},
    loadConversation: async () => structuredClone(c),
    call: async (name: string, input: any) => {
      calls.push(name);
      if (name !== "send") throw Error("Unexpected non-append call: " + name);
      await options.hold;
      if (options.fail) throw Error("Synthetic send outcome is unknown.");
      c.turns.push({
        id: "accepted-" + calls.length,
        prompt: input.text,
        attachments: [],
        items: [],
        createdAt: 2,
        status: "completed",
      });
      store.flush();
      if (options.commitThenFail)
        throw Error("Synthetic connection failed after commit.");
      return structuredClone(c);
    },
  };
  const route = createActionRpc(ctx, registry, { durableAppend: options.durable });
  const invoke = async (value: any = {}, header: any = {}, json = false) =>
    inAdapterScope(scope, async () => {
      conversationUpdate(c, false);
      const request = create(requestSchema, {
        header: { conversationId: c.id, mutationId: mark, ...header },
        action: {
          case: "sendMessage",
          value: {
            text: "Self-authored append",
            messageId: "new-user",
            assistantMessageId: "new-assistant",
            parentMessageId: "context:assistant",
            ...value,
          },
        },
      });
      const req: any = Readable.from([
        json ? Buffer.from(JSON.stringify({
          header: { conversation_id: c.id, mutation_id: { session_id: mark.sessionId, version: String(mark.version) } },
          send_message: { text: "Self-authored append", message_id: "new-user", assistant_message_id: "new-assistant", parent_message_id: "context:assistant" },
        })) : Buffer.from(toBinary(requestSchema, request)),
      ]);
      Object.assign(req, {
        method: "POST",
        headers: { "content-type": json ? "application/json" : "application/proto" },
      });
      let body: Buffer | undefined;
      const res: any = {
        writeHead() {},
        end(bytes: Buffer) {
          body = bytes;
        },
      };
      assert.equal(await route(req, res, PERFORM_ACTION_PATH), true);
      return (json ? JSON.parse(body!.toString()) : fromBinary(responseSchema, body!)) as any;
    });
  return { store, c, calls, invoke, scope, root, restart: () => {
    scope = newAdapterScope("f022-local", root, identity);
    inAdapterScope(scope, loadConversationState);
  } };
}

test("durable append blocks a replay after activation loss without claiming success", async (t) => {
  const f = fixture(t, { durable: true });
  const inconsistentTemporaryFlag = { isTemporary: true };
  assert.equal((await f.invoke(inconsistentTemporaryFlag)).ack.outcome.case, "applied");
  f.restart();
  const replay = await f.invoke(inconsistentTemporaryFlag);
  assert.equal(replay.ack.outcome.case, "error");
  assert.equal(replay.ack.outcome.value.error.type, "mutation_unconfirmed");
  assert.equal(replay.ack.outcome.value.messageId, "new-user");
  assert.deepEqual(f.calls, ["send"]);
  assert.equal(f.c.turns.length, 2);
  const conflict = await f.invoke({ text: "Changed payload" });
  assert.equal(conflict.ack.outcome.case, "error");
  assert.equal(conflict.ack.outcome.value.error.type, "invalid_argument");
  assert.deepEqual(f.calls, ["send"]);
});

test("append tombstone survives a process restart", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f022-process-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.resolve("electron/official-ui/api/append-send-receipts.ts")).href;
  const source = `import { durableAppendSend } from ${JSON.stringify(moduleUrl)};
    const root = process.argv[1], reserve = process.argv[2] === "reserve", activation = {};
    const ctx = { account: () => ({ id: "owner" }), sessionIdentity: () => activation, stateDirectory: () => root, isCurrent: () => true };
    process.stdout.write(durableAppendSend(ctx, { key: "mutation", hash: "a".repeat(64) }, reserve));`;
  const run = (action: string) => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, root, action], { encoding: "utf8" });
  assert.equal(run("reserve"), "reserved");
  assert.equal(run("lookup"), "pending");
  assert.equal(run("reserve"), "pending");
});

test("incognito append never writes durable receipt metadata", async (t) => {
  const f = fixture(t, { durable: true });
  f.c.incognito = true;
  assert.equal((await f.invoke()).ack.outcome.case, "applied");
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith("official-append-send-receipts-")), false);
});

test("JSON replay after activation loss is correlated and cannot send twice", async (t) => {
  const f = fixture(t, { durable: true });
  assert.equal((await f.invoke({}, {}, true)).ack.outcome.case, "applied");
  f.restart();
  const replay = await f.invoke({}, {}, true);
  assert.equal(replay.ack.outcome.case, "error");
  assert.equal(replay.ack.outcome.value.error.type, "mutation_unconfirmed");
  assert.equal(replay.ack.outcome.value.messageId, "new-user");
  assert.deepEqual(f.calls, ["send"]);
});

test("unavailable durable receipt storage refuses before dispatch", async (t) => {
  const f = fixture(t, { durable: true });
  const ownerHash = createHash("sha256").update("f022-local").digest("hex").slice(0, 32);
  fs.writeFileSync(path.join(f.root, "official-append-send-receipts-" + ownerHash), "invalid");
  const response = await f.invoke();
  assert.equal(response.ack.outcome.case, "error");
  assert.deepEqual(f.calls, []);
});

test("accepted append replay with the same parent returns its ACK, not an edit or second turn", async (t) => {
  const f = fixture(t),
    a = await f.invoke(),
    b = await f.invoke();
  assert.equal(a.ack.outcome.case, "applied");
  assert.deepEqual(b, a);
  assert.deepEqual(f.calls, ["send"]);
  assert.equal(f.c.turns.length, 2);
});

test("Android resends the same messages under a fresh mutation before and after restart", async (t) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(t, { hold });
  const android = { clientPlatform: 4 };
  const mutation = (version: bigint) => ({ mutationId: { ...mark, version } });
  const initial = f.invoke(android, mutation(1n));
  const replay = f.invoke(android, { ...mutation(2n), clientCapabilities: {} });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.calls, ["send"]);
  } finally {
    release();
  }
  for (const [version, response] of [[1n, await initial], [2n, await replay]] as const) {
    assert.equal(response.ack.outcome.case, "applied");
    assert.equal(response.ack.highWaterMark.version, version);
  }

  f.restart();
  const reopened = await f.invoke(android, mutation(3n));
  assert.equal(reopened.ack.outcome.case, "applied");
  assert.equal(reopened.ack.highWaterMark.version, 3n);
  const conflict = await f.invoke({ ...android, text: "Changed body using the same message IDs" }, mutation(4n));
  assert.equal(conflict.ack.outcome.value.error.type, "invalid_argument");
  assert.equal(f.c.turns.length, 2);
  assert.deepEqual(f.calls, ["send"]);
});

test("Android resends with an uncertain original send never reissue it", async (t) => {
  const f = fixture(t, { commitThenFail: true });
  const android = { clientPlatform: 4 };
  const original = await f.invoke(android);
  assert.equal(original.ack.outcome.case, "error");

  f.restart();
  const replay = await f.invoke(android, { mutationId: { ...mark, version: 2n } });
  assert.equal(replay.ack.highWaterMark.version, 2n);
  assert.equal(replay.ack.outcome.value.error.type, "mutation_unconfirmed");
  assert.equal(replay.ack.outcome.value.messageId, "new-user");
  assert.deepEqual(f.calls, ["send"]);
  assert.equal(f.c.turns.length, 2);
});

test("concurrent identical appends share one pending send and one outcome", async (t) => {
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const f = fixture(t, { hold });
  const a = f.invoke(),
    b = f.invoke();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.calls, ["send"]);
  release();
  assert.deepEqual(await a, await b);
  assert.equal(f.c.turns.length, 2);
});

test("failed or post-commit unknown sends replay a correlated non-retryable error without dispatch", async (t) => {
  for (const options of [{ fail: true }, { commitThenFail: true }]) {
    const f = fixture(t, options),
      a = await f.invoke(),
      b = await f.invoke();
    assert.deepEqual(a, b);
    assert.deepEqual(f.calls, ["send"]);
    assert.equal(a.ack.outcome.case, "error");
    assert.deepEqual(
      a.ack.highWaterMark,
      create(
        registry.getMessage("anthropic.bard.api.v1alpha.MutationId")!,
        mark,
      ),
    );
    assert.equal(a.ack.outcome.value.action, "send_message");
    assert.equal(a.ack.outcome.value.messageId, "new-user");
    assert.equal(a.ack.outcome.value.error.retryable, false);
    assert.equal(f.c.turns.length, options.commitThenFail ? 2 : 1);
  }
});

test("new mutations can append, changed reuse cannot, and legacy identity-free callers retain behavior", async (t) => {
  const f = fixture(t);
  await f.invoke();
  const conflict = await f.invoke({ text: "Different payload" });
  assert.equal(conflict.ack.outcome.case, "error");
  assert.equal(f.calls.length, 1);
  const next = await f.invoke(
    {
      messageId: "next-user",
      assistantMessageId: "next-assistant",
      parentMessageId: "new-assistant",
    },
    { mutationId: { ...mark, version: 2n } },
  );
  assert.equal(next.ack.outcome.case, "applied");
  assert.equal(f.calls.length, 2);
  const legacy = fixture(t);
  await legacy.invoke(
    { parentMessageId: undefined },
    { mutationId: undefined },
  );
  await legacy.invoke(
    { parentMessageId: undefined },
    { mutationId: undefined },
  );
  assert.equal(legacy.calls.length, 2);
  const other = fixture(t);
  await other.invoke();
  assert.equal(other.calls.length, 1);
});

test("send acknowledgements and replays wait for confirmed admission", async (t) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(t, { hold });
  let acknowledged = 0;
  const first = f.invoke().then(answer => { acknowledged++; return answer; });
  const repeat = f.invoke().then(answer => { acknowledged++; return answer; });
  try {
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(acknowledged, 0);
    assert.equal(f.c.turns.length, 1);
    assert.deepEqual(f.calls, ["send"]);
  } finally {
    release();
  }
  const answers = await Promise.all([first, repeat]);
  assert.equal(answers[0].ack.outcome.case, "applied");
  assert.deepEqual(answers[0], answers[1]);
  assert.equal(f.c.turns.length, 2);
});

test("original mutation queue retries a lost ACK with identical bytes but the API sends once", async (t) => {
  const file = path.join(
      assets,
      "ui/assets/v1/c89083a1f9294fbadd4d36093a5919eaa9ef365ef293036d-BMMjIHf1.js",
    ),
    source = fs.readFileSync(file, "utf8");
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "739f486a9483bebae456b9d651ac0b48dcdee91dc403c26fb812ff12edd5741a",
  );
  const code = source.slice(
    source.indexOf("var F = `/claudeai-rpc/"),
    source.indexOf("function W(e) {", source.indexOf("var Un = class t")),
  );
  const errorModule: any = await import(
      pathToFileURL(path.join(assets, "ui/assets/v1/ce40dc50c-C8v9j2wp.js"))
        .href
    ),
    ConnectError = errorModule.t,
    Code = errorModule.i;
  // Environment adapters: no auth transition/route decoration/telemetry or response headers.
  // Original queue drain, terminal classification, retry/backoff and entry lifecycle run unchanged.
  const sandbox: any = {
    Date,
    Math,
    Promise,
    Error,
    TypeError,
    AbortController,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    navigator: { onLine: true },
    console: { warn() {}, error() {} },
    j: {
      typeName: "ConversationService",
      method: { performAction: { name: "PerformAction" } },
    },
    n: () => false,
    r: () => ({}),
    ne: () => {},
    o: (e: any) => e instanceof TypeError,
    a: () => false,
    c: () => undefined,
    l: { error() {} },
    s: { CHAT_COMPLETION: "chat" },
    w: ConnectError,
    C: Code,
    P: (e: any) =>
      e instanceof ConnectError &&
      e.code !== Code.Canceled &&
      (e.details.length > 0 || !e.metadata.keys().next().done),
    X: () => undefined,
    ir: () => undefined,
    ar: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(code + ";globalThis.Queue=Un;", sandbox);
  const f = fixture(t);
  let attempts = 0,
    settlement = "pending",
    finish!: () => void;
  const done = new Promise<void>((r) => {
    finish = r;
  });
  const request: any = {
    header: { conversationId: f.c.id, mutationId: mark },
    action: { case: "sendMessage", value: {} },
  };
  const queue = new sandbox.Queue({
    organization: () => "self",
    terminalVerdicts: () => true,
    settlementOf: () => settlement,
    boundedDelivery: () => false,
    performAction: async (req: any) => {
      assert.equal(req, request);
      attempts++;
      const answer = await f.invoke();
      if (attempts === 1)
        throw new ConnectError(
          "Synthetic lost ACK after accepted send",
          Code.Unavailable,
        );
      settlement = "acked";
      return answer;
    },
    onAccepted: finish,
    onDropped: finish,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    queue.enqueue(request, 1n);
    await Promise.race([
      done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Queue did not settle")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    queue.clear();
  }
  assert.equal(attempts, 2);
  assert.deepEqual(f.calls, ["send"]);
  assert.equal(f.c.turns.length, 2);
  assert.equal(queue.size, 0);
});
