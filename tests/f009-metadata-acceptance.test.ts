import { regenerationErrorAfter, regenerationErrorBefore, regenerationErrorInput, regenerationErrorTarget, deriveOfficialRegenerationErrorModule } from "../scripts/official-ui-regeneration-error.mjs";
import { verifyOfficialWebAssets } from "../scripts/official-web-assets.mjs";
import { beforeF014Stop } from "./support/f014-resource-chain.mjs";
import { editRetryHubBefore, editRetryHubAfter, deriveOfficialEditRetryModule, editRetryHub } from "../scripts/official-ui-edit-retry.mjs";
/** F009 metadata only: synthetic stores, actual handlers and protocol. No engine/provider. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { Readable, PassThrough } from "node:stream";
import ts from "typescript";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { Store } from "../electron/store/store";
import { CloudStore } from "../runner/src/cloud-store";
import { registerConversationManageHandlers } from "../electron/ipc/conversation-manage-handlers";
import {
  createActionRpc,
  PERFORM_ACTION_PATH,
} from "../electron/official-ui/api/actions";
import {
  conversationAliases,
  conversationsRoute,
} from "../electron/official-ui/api/conversations";
import { loadRegistry, deepCreate } from "../electron/official-ui/api/timeline";
import { organizationUuid } from "../electron/official-ui/api/context";
import {
  newAdapterScope,
  inAdapterScope,
} from "../electron/official-ui/api/scope";
import { guardAdapterContext } from "../electron/official-ui/api/scoped-context";
const registry = loadRegistry(
  "build/official-ui/data/conversation-protocol.json",
);
const input = registry.getMessage(
  "anthropic.bard.api.v1alpha.PerformActionRequest",
)!;
const output = registry.getMessage(
  "anthropic.bard.api.v1alpha.PerformActionResponse",
)!;
const owner = "synthetic-f009",
  real = "11111111-1111-4111-8111-111111111111",
  page = "22222222-2222-4222-8222-222222222222";
const mark = { sessionId: "synthetic-session", version: 1n };
const actions = [
  {
    case: "renameConversation",
    value: { title: "Renamed 中文" },
    field: "title",
    expected: "Renamed 中文",
    wire: "rename_conversation",
  },
  {
    case: "starConversation",
    value: { starred: true },
    field: "pinned",
    expected: true,
    wire: "star_conversation",
  },
  {
    case: "archiveConversation",
    value: { archived: true },
    field: "archived",
    expected: true,
    wire: "archive_conversation",
  },
];
function root(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f009-metadata-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function seed(store: Store) {
  for (const id of [real, "other"])
    store.conversations.push({
      id,
      mode: "chat",
      title: "Original",
      providerId: "inert",
      model: "inert",
      turns: [],
      createdAt: 1,
      updatedAt: 1,
      pinned: false,
      archived: false,
    } as any);
}
function fixture(store: Store) {
  let generation = 1,
    active = true;
  const identity = {},
    calls: any[] = [],
    handlers = new Map<string, Function>();
  registerConversationManageHandlers({
    context: { store, engine: {}, accountGeneration: () => generation },
    engineOf: () => undefined,
    handle: (name: string, fn: Function) => handlers.set(name, fn),
  } as any);
  const scope = newAdapterScope(owner, undefined, identity);
  const raw: any = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    stateDirectory: () => os.tmpdir(),
    isCurrent: () => active,
    strictActionSemantics: true,
    log() {},
    settings: () => store.settings,
    listConversations: async () => structuredClone(store.conversations),
    loadConversation: async (id: string) =>
      structuredClone(store.conversations.find((c) => c.id === id)),
    call: async (name: string, ...args: any[]) => {
      calls.push([name, ...args]);
      return handlers.get(name)!(...args);
    },
  };
  const ctx = guardAdapterContext(raw),
    rpc = createActionRpc(ctx, registry);
  inAdapterScope(scope, () => conversationAliases.restore(page, real));
  return {
    store,
    scope,
    ctx,
    rpc,
    calls,
    retire: () => {
      generation++;
      active = false;
    },
  };
}
function encoded(action: any) {
  return Buffer.from(
    toBinary(
      input,
      deepCreate(input, {
        header: { conversationId: page, mutationId: mark, existingOnly: true },
        action: { case: action.case, value: action.value },
      }),
    ),
  );
}
function rpcCall(f: ReturnType<typeof fixture>, action: any, req?: any) {
  req ??= Readable.from([encoded(action)]);
  req.method = "POST";
  req.headers = { "content-type": "application/proto" };
  let status = 0,
    body = Buffer.alloc(0);
  const res: any = {
    writeHead: (s: number) => {
      status = s;
    },
    end: (b: any) => {
      body = Buffer.from(b);
    },
  };
  return {
    run: inAdapterScope(f.scope, () => f.rpc(req, res, PERFORM_ACTION_PATH)),
    answer: () => ({ status, value: fromBinary(output, body) as any }),
  };
}
async function rest(
  f: ReturnType<typeof fixture>,
  suffix: string,
  body?: unknown,
  method = body === undefined ? "GET" : "PUT",
) {
  const url = new URL(
    `/api/organizations/${organizationUuid(owner)}/${suffix}`,
    "http://synthetic.invalid",
  );
  const req: any = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  );
  req.method = method;
  req.headers = {};
  let status = 0,
    value: any;
  const res: any = {
    writeHead: (s: number) => (status = s),
    end: (b: any) => {
      value = JSON.parse(String(b));
    },
  };
  await inAdapterScope(f.scope, () =>
    conversationsRoute(req, res, url.pathname, url, f.ctx),
  );
  return { status, value };
}
// Exact original ownership and failure classification methods, not a replacement UI model.
// Resource availability is explicit: this probe does not render hooks or the DOM.
function originalFailureProbe(t: any) {
  const file =
    "build/official-ui/ui/assets/v1/30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js";
  if (!fs.existsSync(file)) {
    t.skip(
      "Original archived hub resource is required for this consumer comparison",
    );
    return undefined;
  }
  let source = fs.readFileSync(file, "utf8");
  source = beforeF014Stop("30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js", source);
  if (createHash("sha256").update(source).digest("hex") === "87194090ced9e671d94d8b6dece3bf02e344e23b4f970447ec172c0a6e3ed781") {
    const final = source;
    assert.equal(source.split(regenerationErrorAfter).length, 2);
    source = source.replace(regenerationErrorAfter, regenerationErrorBefore);
    assert.equal(createHash("sha256").update(source).digest("hex"), regenerationErrorInput);
    assert.equal(deriveOfficialRegenerationErrorModule(regenerationErrorTarget, source), final);
  }
  // The newer pinned F008 projection does not change the methods below. Reverse
  // only its exact full output in memory, then retain the original hash check.
  if (createHash("sha256").update(source).digest("hex") ===
      "afc1d3758e53500d00ddc331375621b68bc6c5f100bffa2afbb1a1dd9294a830") {
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
  const cls = vars.get("U$")!.initializer as ts.ClassExpression;
  const methods = [
    "ownsSession",
    "ownsMark",
    "foreignSeenOnce",
    "settleError",
  ].map((name) => {
    const m = cls.members.find(
      (m) => ts.isMethodDeclaration(m) && m.name?.getText(ast) === name,
    );
    assert.ok(m);
    return m.getText(ast);
  });
  const constants = ["Nte", "Pte"]
    .map((name) => `var ${vars.get(name)!.getText(ast)};`)
    .join("\n");
  const code =
    constants +
    `({methods:{${methods.join(",")}}, noticeNames:${vars.get("jle")!.initializer!.getText(ast)}, transient:${vars.get("pv")!.initializer!.getText(ast)}})`;
  const original: any = vm.runInNewContext(code, {
    e: { FOREIGN_SEEN_CAP: 100 },
    Y: { USER: 1 },
  });
  return (ack: any) => {
    const gate: any = {
      ...original.methods,
      session: { ownedSessionIds: new Set([mark.sessionId]) },
      floorVersion: 0n,
      latestVersion: 1n,
      foreignSeen: new Set(),
      pendingFailures: [],
      failedVersions: new Map(),
      retryStubByVersion: new Map(),
      sentByVersion: new Map(),
      overlay: { messages: new Map() },
    };
    // pv is only consulted for explicit no-message failure codes; use its original literal value.
    const settle = vm.runInNewContext(`({${methods.join(",")}})`, {
      e: { FOREIGN_SEEN_CAP: 100 },
      Y: { USER: 1 },
      pv: original.transient,
    });
    Object.assign(gate, settle);
    gate.settleError(ack.highWaterMark, ack.outcome.value);
    return {
      foreign: gate.pendingFailures[0]?.foreign,
      version: gate.pendingFailures[0]?.version,
      noticeEligible: original.noticeNames.has(ack.outcome.value.action),
    };
  };
}

test("actual PB rename/pin and REST archive keep stable alias identity through repeated lists and Store reopen", async (t) => {
  const dir = root(t),
    store = new Store(dir);
  seed(store);
  store.flush();
  const f = fixture(store);
  for (const action of actions.slice(0, 2)) {
    const op = rpcCall(f, action);
    await op.run;
    assert.equal(op.answer().value.ack.outcome.case, "applied");
  }
  const archive = await rest(f, `chat_conversations/${page}`, {
    is_archived: true,
  });
  assert.equal(archive.value.uuid, page);
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.deepEqual(
      (await rest(f, "chat_conversations_v2?archived=true")).value.data.map(
        (r: any) => r.uuid,
      ),
      [page],
    );
    const active = (await rest(f, "chat_conversations_v2")).value.data;
    assert.deepEqual(
      active.map((r: any) => r.uuid),
      ["other"],
    );
  }
  assert.equal(f.calls.length, 3);
  assert.ok(
    f.calls.every((c) => c[0] === "updateConversation" && c[1] === real),
  );
  const reopened = fixture(new Store(dir));
  assert.equal(
    (await rest(reopened, `chat_conversations/${page}`)).value.name,
    "Renamed 中文",
  );
  const unarchive = await rest(reopened, `chat_conversations/${page}`, {
    is_archived: false,
  });
  assert.equal(unarchive.value.uuid, page);
  const rows = (await rest(reopened, "chat_conversations_v2")).value.data;
  assert.equal(rows.filter((r: any) => r.uuid === page).length, 1);
  assert.equal(
    rows.some((r: any) => r.uuid === real),
    false,
  );
  assert.equal(new Store(dir).conversation(real).pinned, true);
  assert.equal(store.conversation("other").title, "Original");
});

test("the original Chat mark unread and read actions survive reopening the store", async (t) => {
  const dir = root(t);
  const store = new Store(dir);
  seed(store);
  store.conversation(real).turns.push({
    id: "settled-turn",
    prompt: "A completed Chat",
    attachments: [],
    items: [],
    status: "completed",
    createdAt: 2,
  });
  store.flush();
  const target = `chat_conversations/${page}/read_state`;
  const writeReadState = (f: ReturnType<typeof fixture>, state: string) =>
    rest(f, target, { state }, "POST");
  const readRow = async (f: ReturnType<typeof fixture>) =>
    (await rest(f, "chat_conversations_v2")).value.data.find((row: { uuid: string }) => row.uuid === page);

  const initial = fixture(store);
  assert.equal((await readRow(initial)).has_settled, true);
  const marked = await writeReadState(initial, "unread");
  assert.equal(marked.status, 200);
  assert.equal(marked.value.written, true);

  const reopened = fixture(new Store(dir));
  const unread = await readRow(reopened);
  assert.equal(unread.unread, true);
  assert.equal(BigInt(unread.revision_ns), BigInt(Date.parse(marked.value.revision)) * 1_000_000n);
  assert.equal(reopened.store.conversation("other").unread, undefined);

  const read = await writeReadState(reopened, "read");
  assert.equal(read.status, 200);
  assert.equal(read.value.last_read_at, read.value.revision);
  assert.ok(Date.parse(read.value.revision) > Date.parse(marked.value.revision));
  assert.equal((await readRow(fixture(new Store(dir)))).unread, false);

  await writeReadState(reopened, "unread");
  assert.deepEqual(await rest(reopened, target, { unread: false }), {
    status: 200,
    value: { unread: false },
  });
  assert.equal((await readRow(fixture(new Store(dir)))).unread, false);
  assert.equal((await writeReadState(reopened, "pending")).status, 400);
});

test("Chat read state answers only after the hosted row is acknowledged", async (t) => {
  let started!: () => void;
  let release!: () => void;
  const writeStarted = new Promise<void>((resolve) => { started = resolve; });
  const writeAllowed = new Promise<void>((resolve) => { release = resolve; });
  const persisted: boolean[] = [];
  const store = new CloudStore({
    root: root(t),
    userId: 1,
    log() {},
    transport: {
      request: async (op, _user, body: any) => {
        if (op === "store.conversations.put" && body.doc.conversation.id === real) {
          started();
          await writeAllowed;
          persisted.push(body.doc.conversation.unread);
        }
        return {};
      },
    },
  });
  t.after(async () => {
    release();
    await store.close();
  });
  seed(store);
  const f = fixture(store);
  const target = `chat_conversations/${page}/read_state`;
  let replied = false;
  const mark = rest(f, target, { state: "unread" }, "POST").then((answer) => {
    replied = true;
    return answer;
  });
  await Promise.race([writeStarted, mark]);
  assert.equal(replied, false);
  release();
  assert.equal((await mark).status, 200);
  assert.deepEqual(persisted, [true]);
  assert.deepEqual(await rest(f, target, { unread: false }), {
    status: 200,
    value: { unread: false },
  });
  assert.deepEqual(persisted, [true, false]);
});

for (const action of actions)
  test(`${action.case}: failed persistence is bound to the original PB mutation and never applied`, async (t) => {
    const store = new Store(root(t));
    seed(store);
    store.flush();
    const f = fixture(store);
    const write = store.write.bind(store);
    store.write = (name, value) => {
      if (name === "conversations.json")
        throw Error("Synthetic persistence unavailable");
      write(name, value);
    };
    const op = rpcCall(f, action);
    await op.run;
    const answer = op.answer();
    assert.equal(answer.status, 200);
    const ack = answer.value.ack;
    assert.equal(ack.outcome.case, "error");
    assert.equal(ack.outcome.value.error.retryable, false);
    assert.equal(f.calls.length, 1);
    const probe = originalFailureProbe(t);
    if (!probe) return;
    const observed = probe(ack);
    assert.equal(
      observed.foreign,
      false,
      "original gate must associate the failure with this mutation, not foreign failure",
    );
    assert.equal(observed.version, mark.version);
    assert.equal(ack.outcome.value.action, action.wire);
    if (action.case !== "archiveConversation")
      assert.equal(
        observed.noticeEligible,
        true,
        "original rename/star notification gate requires snake_case action",
      );
  });

test("Cloud lost ACK rejects once while GET truth remains uncertain; readback is not rollback or action replay", async (t) => {
  for (const action of actions) {
    let writes = 0;
    const committed = new Map<string, any>();
    const store = new CloudStore({
      root: root(t),
      userId: 1,
      log() {},
      transport: {
        request: async (op, _user, body: any) => {
          if (op === "store.conversations.put") {
            writes++;
            committed.set(
              body.doc.conversation.id,
              structuredClone(body.doc.conversation),
            );
            throw Error("Synthetic response lost after commit");
          }
          return {};
        },
      },
    });
    t.after(() => store.close());
    seed(store);
    const f = fixture(store),
      op = rpcCall(f, action);
    await op.run;
    await store.settled();
    assert.equal(op.answer().value.ack.outcome.case, "error");
    assert.equal(f.calls.length, 1);
    assert.ok(writes > 0);
    const callsBefore = f.calls.length,
      writesBefore = writes;
    const row = (await rest(f, `chat_conversations/${page}`)).value;
    const readField =
      action.field === "title"
        ? "name"
        : action.field === "pinned"
          ? "is_starred"
          : "is_archived";
    assert.equal(row[readField], action.expected);
    assert.equal((committed.get(real) as any)[action.field], action.expected);
    assert.equal(f.calls.length, callsBefore);
    assert.equal(writes, writesBefore);
    // This test never retries the action. Store.close may use its existing persistence policy.
  }
});

test("invalid PB title and retired activation reject without write; cancel remains a UI no-request criterion", async (t) => {
  const store = new Store(root(t));
  seed(store);
  store.flush();
  const f = fixture(store),
    before = JSON.stringify(store.conversations);
  for (const title of ["", " ", "x".repeat(201)]) {
    const op = rpcCall(f, { case: "renameConversation", value: { title } });
    await op.run;
    assert.equal(op.answer().value.ack.outcome.case, "error");
  }
  assert.equal(JSON.stringify(store.conversations), before);
  const dispatched = f.calls.length;
  const pending = new PassThrough(),
    op = rpcCall(f, actions[0], pending);
  f.retire();
  pending.end(encoded(actions[0]));
  await op.run;
  assert.equal(op.answer().value.ack.outcome.case, "error");
  assert.equal(f.calls.length, dispatched);
  assert.equal(JSON.stringify(store.conversations), before);
});

test("metadata ACK association preserves successful ACKs, absent mutation identity and unrelated refusals", async (t) => {
  const store = new Store(root(t));
  seed(store);
  store.flush();
  const f = fixture(store);
  const success = rpcCall(f, actions[1]);
  await success.run;
  const accepted = success.answer().value.ack;
  assert.equal(accepted.outcome.case, "applied");
  assert.equal(accepted.highWaterMark.sessionId, mark.sessionId);
  assert.equal(accepted.highWaterMark.version, mark.version);
  const other = rpcCall(f, {
    case: "setCurrentLeaf",
    value: { currentLeafMessageId: "missing" },
  });
  await other.run;
  const refused = other.answer().value.ack;
  assert.equal(refused.outcome.case, "error");
  assert.equal(refused.outcome.value.action, "setCurrentLeaf");
  assert.equal(refused.highWaterMark, undefined);
  const bytes = toBinary(
    input,
    deepCreate(input, {
      header: { conversationId: page },
      action: { case: "renameConversation", value: { title: "" } },
    }),
  );
  const noMark = rpcCall(f, actions[0], Readable.from([Buffer.from(bytes)]));
  await noMark.run;
  assert.equal(noMark.answer().value.ack.outcome.case, "error");
  assert.equal(
    noMark.answer().value.ack.highWaterMark,
    undefined,
    "never invent a mutation identity",
  );
});

function originalArchiveErrorProbe(t: any) {
  const assets = "build/official-ui/ui/assets/v1";
  const sources = new Map<string, string>();
  const files = [
    [
      "shared-l-p-m-w-0-C_nAiu5o.js",
      "e715632eecebd51dbb739ec04e49ab87648d3a2aaeb31fc543ed0d58e0b8fded",
    ],
    [
      "shared-m-1-Nm0kn4Ee.js",
      "35709256161ff9ce70f2c06409e7409be97ec3d244a105be9a3af44c53e8df63",
    ],
    [
      "shared-39-BVbIfnmZ.js",
      "8c38df2034467d801dc671a497e2183f95af3d15aaed0a65493d5351f0eeb305",
    ],
  ];
  if (files.some(([name]) => !fs.existsSync(path.join(assets, name)))) {
    t.skip(
      "Original API parser and archive resources are required for this consumer comparison",
    );
    return undefined;
  }
  verifyOfficialWebAssets(process.cwd(), {
    onChatStarInput: (name, source) => {
      if (files.some(([file]) => file === name)) sources.set(name, source);
    },
  });
  const asts = files.map(([name, hash]) => {
    const source = sources.get(name);
    assert.ok(source, `Missing verified source ${name}`);
    assert.equal(createHash("sha256").update(source).digest("hex"), hash);
    return ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
  });
  function declaration(ast: ts.SourceFile, name: string) {
    for (const stmt of ast.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name)
        return stmt.getText(ast);
      if (ts.isVariableStatement(stmt))
        for (const d of stmt.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === name)
            return `var ${d.getText(ast)};`;
    }
    throw Error(`Missing original declaration ${name}`);
  }
  function arrow(ast: ts.SourceFile, needle: string) {
    const matches: ts.ArrowFunction[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isArrowFunction(node) && node.getText(ast).includes(needle))
        matches.push(node);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    matches.sort((a, b) => a.getWidth(ast) - b.getWidth(ast));
    assert.ok(matches[0], `Missing original arrow ${needle}`);
    return matches[0].getText(ast);
  }
  const parse: any = vm.runInNewContext(
    ["_3", "qv", "XG", "x$"]
      .map((name) => declaration(asts[0], name))
      .join("\n") + "({XG, visibility:x$, ApiError:_3})",
    {},
  );
  const noToast = arrow(asts[1], 'ap(t) !== "user_facing"');
  const retry = arrow(asts[1], "t.statusCode === 429 && e < 30");
  const rejected = arrow(asts[2], "let t = yR(e)");
  return (value: any, status: number) => {
    const error = parse.XG({
      status,
      response: value,
      fallbackMessage: "HTTP failure",
      rawBody: JSON.stringify(value),
      headers: {},
      endpoint: "/chat_conversations/synthetic",
      method: "PUT",
    });
    const shown: any[] = [],
      results: any[] = [];
    const suppressGeneric = vm.runInNewContext(`(${rejected})`, {
      yR: () => false,
      x$: parse.visibility,
      p: (...args: any[]) => results.push(args),
      to: () => false,
      TB: () => false,
      a: (...args: any[]) => shown.push(["api", ...args]),
      i: (...args: any[]) => shown.push(["generic", ...args]),
      c: true,
      s: { formatMessage: (message: any) => message.defaultMessage },
      f: "refused",
    });
    suppressGeneric(error);
    return {
      message: error.message,
      fromApiEnvelope: error.fromApiEnvelope,
      visibility: parse.visibility(error),
      shown,
      results,
      noToast: vm.runInNewContext(`(${noToast})`, {
        ap: parse.visibility,
        x9: () => false,
        e: undefined,
      })(error),
      retry: vm.runInNewContext(`(${retry})`, {
        _3: parse.ApiError,
        yQ: () => 0,
        n: {},
      })(0, error),
    };
  };
}

test("REST archive unknown outcome preserves original user-facing error and never claims rollback or retries", async (t) => {
  for (const archived of [true, false]) {
    const store = new Store(root(t));
    seed(store);
    store.conversations[0].archived = !archived;
    store.flush();
    const f = fixture(store);
    const flush = store.flush.bind(store);
    store.flush = () => {
      throw Error("Synthetic disk refusal");
    };
    const response = await rest(f, `chat_conversations/${page}`, {
      is_archived: archived,
    });
    assert.equal(response.status, 500);
    assert.equal(response.value.type, "error");
    assert.equal(response.value.error.type, "api_error");
    assert.equal(
      response.value.error.message,
      "The archive update could not be confirmed. Some session changes may already have occurred; reopen before retrying.",
    );
    assert.equal(response.value.error.details.error_visibility, "user_facing");
    assert.equal(f.calls.length, 1);
    assert.equal(
      store.conversations[0].archived,
      archived,
      "unknown is not rollback",
    );
    assert.equal(new Store(store.root).conversations[0].archived, !archived);
    const probe = originalArchiveErrorProbe(t);
    if (probe) {
      const observed = probe(response.value, response.status);
      assert.equal(observed.message, response.value.error.message);
      assert.equal(observed.fromApiEnvelope, true);
      assert.equal(observed.visibility, "user_facing");
      assert.equal(
        observed.noToast,
        false,
        "original archive hook permits original API error toast",
      );
      assert.equal(observed.retry, false);
      assert.equal(
        observed.shown.length,
        0,
        "original row must not add its generic Try again message",
      );
      assert.deepEqual(JSON.parse(JSON.stringify(observed.results)), [
        [false, true],
      ]);
    }
    store.flush = flush;
    flush();
    assert.equal(
      new Store(store.root).conversations[0].archived,
      archived,
      "later persistence may commit without another archive action",
    );
    assert.equal(f.calls.length, 1);
  }
});

test("archive error envelope is limited to the exact existing unknown outcome; unrelated failures retain their boundary", async (t) => {
  const store = new Store(root(t));
  seed(store);
  store.flush();
  const f = fixture(store);
  store.flush = () => {
    throw Error("Synthetic unrelated persistence failure");
  };
  await assert.rejects(
    rest(f, `chat_conversations/${page}`, {
      name: "new title",
      is_archived: true,
    }),
    /Synthetic unrelated persistence failure/,
  );
  const count = f.calls.length;
  f.retire();
  await assert.rejects(
    rest(f, `chat_conversations/${page}`, { is_archived: false }),
  );
  assert.equal(
    f.calls.length,
    count,
    "retired context cannot be turned into a user-facing archive write",
  );
});
