/** Real native setter/Store and REST route; no provider, UI or paid requests. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Store, WebSearchSaveError } from "../electron/store/store";
import { registerConversationHandlers } from "../electron/ipc/conversations";
import { openPolicy } from "../shared/client-policy";
import { conversationsRoute, conversationAliases } from "../electron/official-ui/api/conversations";
import { organizationUuid } from "../electron/official-ui/api/context";
import { inAdapterScope, newAdapterScope } from "../electron/official-ui/api/scope";

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f013-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root), handlers = new Map<string, Function>(), events: any[] = [];
  const id = "11111111-1111-4111-8111-111111111111";
  store.settings.providers = [{ id: "p", name: "P", protocol: "responses", model: "m", models: [], baseUrl: "http://127.0.0.1:1" }];
  store.conversations.push(...[id, "second"].map(id => ({ id, title: id, mode: "chat" as const,
    providerId: "p", model: "m", createdAt: 1, updatedAt: 1, pinned: false, archived: false, turns: [] })));
  store.flush();
  let stopped = 0, identity = {}, policy = openPolicy, busy = false;
  const engine = { policy: () => policy, stop: async () => { stopped++; } };
  const context: any = { store, engine, activeAccount: { id: "owner" }, accountGeneration: () => identity,
    replyFeedback: {}, selectedAttachments: new Map(), allowedFolder() {},
    noActive() { if (busy) throw Error("Busy"); }, push: (event: any) => events.push(event) };
  registerConversationHandlers((name, fn) => handlers.set(name, fn), context);
  let owner = "owner", afterLoad: (() => void) | undefined;
  const calls: any[] = [];
  const ctx: any = { account: () => ({ id: owner }), sessionIdentity: () => identity,
    stateDirectory: () => root, settings: () => store.settings,
    loadConversation: async (key: string) => { const value = store.conversations.find(c => c.id === key); afterLoad?.(); return value && structuredClone(value); },
    call: async (name: string, ...args: unknown[]) => { calls.push([name, ...args]); return handlers.get(name)!(...args); } };
  const scope = newAdapterScope(owner, root, identity);
  return { root, store, id, ctx, events, calls, context,
    choose: (...args: unknown[]) => handlers.get("setConversationWebSearch")!(...args),
    stopCount: () => stopped, busy: () => { busy = true; }, retire: () => { identity = {}; },
    policy: (p: any) => { policy = p; }, afterLoad: (fn: () => void) => { afterLoad = fn; },
    async rest(body: unknown, options: { org?: string; id?: string; method?: string; whileReading?: () => void } = {}) {
      const target = options.id ?? id;
      const p = `/api/organizations/${organizationUuid(options.org ?? owner)}/chat_conversations/${target}`;
      const chunks = async function* () { options.whileReading?.(); yield Buffer.from(JSON.stringify(body)); };
      const req = Object.assign(Readable.from(chunks()), { method: options.method ?? "PUT", headers: {} });
      let status = 0, result: any;
      const res: any = { writeHead: (n: number) => { status = n; }, end: (b: any) => { result = b && JSON.parse(Buffer.from(b).toString()); } };
      await inAdapterScope(scope, () => conversationsRoute(req as any, res, p, new URL(p, "http://localhost"), ctx));
      return { status, body: result };
    },
    alias: (page: string) => inAdapterScope(scope, () => conversationAliases.restore(page, id)),
  };
}

test("local search write failure restores original-control state without publishing or restarting", async t => {
  for (const enabled of [true, false]) {
    const f = fixture(t), c = f.store.conversation(f.id);
    c.webSearch = !enabled; c.research = true;
    f.store.flush();
    const before = structuredClone(c), saved = fs.readFileSync(path.join(f.root, "conversations.json"));
    f.store.write = () => { throw Error("synthetic disk failure"); };
    await assert.rejects(f.choose(f.id, enabled), WebSearchSaveError);
    assert.deepEqual(c, before);
    assert.deepEqual(fs.readFileSync(path.join(f.root, "conversations.json")), saved);
    assert.equal(f.stopCount(), 0);
    assert.deepEqual(f.events, [{ type: "conversation", conversation: before }]);
  }
});

test("search stages provider/model and research flags and avoids unrelated settings/project writes", async t => {
  const f = fixture(t), c = f.store.conversation(f.id);
  f.store.settings.providers.push({ ...f.store.settings.providers[0], id: "other", model: "other-model" });
  const before = structuredClone(c), write = f.store.write.bind(f.store), names: string[] = [];
  f.store.write = (name, value) => { names.push(name); if (name !== "conversations.json") throw Error("unrelated write"); write(name, value); };
  await f.choose(f.id, true, "other", "other-model");
  assert.deepEqual(names, ["conversations.json"]);
  assert.equal(new Store(f.root).conversation(f.id).webSearch, true);
  assert.equal(c.providerId, "other"); assert.equal(c.model, "other-model");
  assert.equal(f.store.conversation("second").webSearch, undefined);
  c.research = true;
  await f.choose(f.id, false);
  assert.equal(new Store(f.root).conversation(f.id).research, undefined);
  assert.equal(f.stopCount(), 2);
  assert.notDeepEqual(c, before);
});

test("failed model switch keeps both old selection and independent conversations", async t => {
  const f = fixture(t), c = f.store.conversation(f.id);
  f.store.settings.providers.push({ ...f.store.settings.providers[0], id: "other", model: "other-model" });
  const before = structuredClone(f.store.conversations);
  f.store.write = () => { throw Error("disk"); };
  await assert.rejects(f.choose(f.id, true, "other", "other-model"), WebSearchSaveError);
  assert.deepEqual(f.store.conversations, before); assert.equal(c.providerId, "p");
});

test("native REST persists only the exact search setting and returns the original full row", async t => {
  const f = fixture(t);
  for (const enabled of [true, false]) {
    const r = await f.rest({ settings: { enabled_web_search: enabled } });
    assert.equal(r.status, 200); assert.equal(r.body.name, f.id);
    assert.equal(r.body.settings.enabled_web_search, enabled);
    assert.equal(new Store(f.root).conversation(f.id).webSearch, enabled);
  }
  assert.deepEqual(f.calls.map(c => c[0]), ["setConversationWebSearch", "setConversationWebSearch"]);
});

test("native REST rejects unrelated settings, mixed mutations and malformed booleans before dispatch", async t => {
  const f = fixture(t);
  for (const body of [
    { settings: { enabled_web_search: "true" } }, { settings: {} },
    { settings: { enabled_web_search: true, compass_mode: "advanced" } },
    { settings: { enabled_web_search: true }, name: "rename" }, { settings: [] },
  ]) assert.equal((await f.rest(body)).status, 400);
  assert.equal(f.calls.length, 0);
});

test("native REST keeps Web controls, ownership and account changes outside this fallback", async t => {
  for (const restricted of ["readOnly", "strictActionSemantics"]) {
    const f = fixture(t); f.ctx[restricted] = true;
    assert.equal((await f.rest({ settings: { enabled_web_search: true } })).status, 403);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(t);
  assert.equal((await f.rest({ settings: { enabled_web_search: true } }, { org: "foreign" })).status, 404);
  assert.equal(f.calls.length, 0);
  f.afterLoad(f.retire);
  assert.equal((await f.rest({ settings: { enabled_web_search: true } })).status, 409);
  assert.equal(f.calls.length, 0);
});

test("native REST delegates policy/busy checks and exposes save failure without false success", async t => {
  for (const failure of ["policy", "busy", "disk"]) {
    const f = fixture(t);
    if (failure === "policy") f.policy({ ...openPolicy, webSearch: false });
    if (failure === "busy") f.busy();
    if (failure === "disk") f.store.write = () => { throw Error("disk"); };
    const r = await f.rest({ settings: { enabled_web_search: true } });
    assert.equal(r.status, 503); assert.equal(r.body.error.details.error_visibility, "user_facing");
    assert.equal(f.store.conversation(f.id).webSearch, undefined);
    assert.equal(f.stopCount(), 0);
  }
});

test("native REST resolves only owned aliases and requires the saved state to match", async t => {
  const f = fixture(t), page = "22222222-2222-4222-8222-222222222222";
  f.alias(page);
  assert.equal((await f.rest({ settings: { enabled_web_search: true } }, { id: page })).status, 200);
  assert.equal(f.calls[0][1], f.id);
  f.ctx.call = async () => undefined;
  assert.equal((await f.rest({ settings: { enabled_web_search: false } })).status, 409);
});


test("search body cannot outlive a same-account activation", async t => {
  const f = fixture(t);
  const r = await f.rest({ settings: { enabled_web_search: true } }, { whileReading: f.retire });
  assert.equal(r.status, 409); assert.equal(f.calls.length, 0);
});

test("search incognito preferences stay in memory and do not write local history", async t => {
  const f = fixture(t), c = f.store.conversation(f.id); c.incognito = true;
  f.store.flush();
  const before = fs.readFileSync(path.join(f.root, "conversations.json"));
  f.store.write = () => { throw Error("incognito must not write"); };
  await f.choose(f.id, true); assert.equal(c.webSearch, true);
  assert.deepEqual(fs.readFileSync(path.join(f.root, "conversations.json")), before);
  assert.equal(new Store(f.root).conversations.some(row => row.id === f.id), false);
});

// Run the actual CloudStore override in isolation without its relay transport.
test("runner search persistence retains the existing flush and confirmation contract", async t => {
  const ts = await import("typescript"), vm = await import("node:vm");
  const file = fs.readFileSync("runner/src/cloud-store.ts", "utf8");
  const ast = ts.createSourceFile("cloud-store.ts", file, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((node): node is import("typescript").ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "CloudStore")!;
  const method = declaration.members.find(node => node.name?.getText(ast) === "persistWebSearchPreference")!;
  const source = ts.transpileModule(`class Probe { ${method.getText(ast).replace("override ", "")} }; Probe;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const Probe = vm.runInNewContext(source), f = fixture(t), order: string[] = [];
  f.store.persistWebSearchPreference = Probe.prototype.persistWebSearchPreference;
  f.store.flush = () => { order.push("flush"); assert.equal(f.store.conversation(f.id).webSearch, true); };
  f.store.write = () => { throw Error("runner cannot write account JSON locally"); };
  f.store.confirmConversationMetadata = async (_conversation, current, alreadyFlushed) => {
    assert.equal(current(), true); assert.equal(alreadyFlushed, true); assert.equal(f.stopCount(), 1); order.push("confirm");
  };
  await f.choose(f.id, true);
  assert.deepEqual(order, ["flush", "confirm"]);
});
