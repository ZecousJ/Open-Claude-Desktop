/**
 * R3-S4: the memory stores (memory.json on this computer, the Claudex
 * service with its cache), the service that combines them with the policy,
 * the IPC domain and the data export.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalMemoryStore } from "../../electron/memory/local-store";
import {
  memoryCacheFile,
  memoryError,
  RemoteMemoryStore,
} from "../../electron/memory/remote-store";
import { MemoryService } from "../../electron/memory/service";
import {
  MemoryConflictError,
  MemoryOfflineError,
  MemoryUnsupportedError,
} from "../../electron/memory/store";
import {
  cleanEdit,
  looksSecret,
  memoryMessages,
  projectScope,
} from "../../electron/memory/types";
import {
  ClaudexMemory,
  parseMemoryBootstrap,
  parseMemoryView,
} from "../../electron/sub2api/claudex-memory";
import { Sub2ApiError } from "../../electron/sub2api/http";
import {
  exportEntries,
  exportedMemory,
} from "../../electron/conversations/data-export";
import { registerMemoryHandlers } from "../../electron/ipc/memory";
import { EngineExtensions } from "../../electron/engine/engine-extensions";
import { memoryExtensionId } from "../../electron/memory/inject";
import { openPolicy, type ClientPolicy } from "../../shared/client-policy";
import type { AppEvent, PublicAccount } from "../../shared/types";

const projectId = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

function tempRoot(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-memory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const mode = (file: string) => fs.statSync(file).mode & 0o777;

// ---------------------------------------------------------------- helpers

test("edits are cleaned to one line and secrets are recognised", () => {
  assert.equal(
    cleanEdit("  likes\n\ttea \u0007 and  cake "),
    "likes tea and cake",
  );
  assert.equal(looksSecret("my password is hunter2"), true);
  assert.equal(looksSecret("key sk-abcdefghijklmnop"), true);
  assert.equal(looksSecret("card 4111 1111 1111 1111"), true);
  assert.equal(looksSecret("born 1990, phone 1234 5678 9012 3"), false);
  assert.equal(looksSecret("Prefers metric units"), false);
  assert.equal(projectScope(projectId.toUpperCase()), `project:${projectId}`);
  assert.equal(projectScope("not-a-uuid"), undefined);
});

// ------------------------------------------------------------ local store

test("the local store writes memory.json atomically with mode 0600", async (t) => {
  const root = tempRoot(t);
  let now = 1_000;
  const store = new LocalMemoryStore(root, () => now);
  assert.deepEqual(store.current().docs, []);
  assert.equal(store.current().prefs, null);
  const doc = await store.saveDoc("global", {
    content: "Works on Claudex.",
    source: "user",
    baseRevision: 0,
  });
  assert.equal(doc.revision, 1);
  assert.equal(doc.source, "user");
  assert.equal(mode(path.join(root, "memory.json")), 0o600);
  assert.equal(fs.existsSync(path.join(root, "memory.json.tmp")), false);
  now = 2_000;
  const second = await store.saveDoc("global", {
    content: "Works on Claudex and Sub2API.",
    source: "generated",
    baseRevision: 1,
  });
  assert.equal(second.revision, 2);
  assert.equal(second.generatedAt, 2_000);
  assert.equal(second.createdAt, 1_000);
  await assert.rejects(
    store.saveDoc("global", { content: "x", source: "user", baseRevision: 1 }),
    (error) =>
      error instanceof MemoryConflictError && error.currentRevision === 2,
  );
  await assert.rejects(
    store.saveDoc(`project:${projectId}`, {
      content: "é".repeat(8 * 1024 + 1),
      source: "user",
      baseRevision: 0,
    }),
    { message: memoryMessages.tooLarge },
  );
  // A new store reads what the first wrote.
  const again = new LocalMemoryStore(root);
  assert.equal(
    again.current().docs[0].content,
    "Works on Claudex and Sub2API.",
  );
});

test("local edits: limits, secrets, folding into a summary and reset", async (t) => {
  const root = tempRoot(t);
  const store = new LocalMemoryStore(root);
  const first = await store.addEdit("global", "Prefers\nshort answers");
  assert.equal(first.text, "Prefers short answers");
  await assert.rejects(store.addEdit("global", "   "), {
    message: memoryMessages.emptyEdit,
  });
  await assert.rejects(store.addEdit("global", "x".repeat(501)), {
    message: memoryMessages.editTooLong,
  });
  await assert.rejects(store.addEdit("global", "my api key: abcdef123"), {
    message: memoryMessages.sensitive,
  });
  const second = await store.addEdit("global", "Lives in Berlin");
  const project = await store.addEdit(`project:${projectId}`, "Uses Go");
  for (let i = 2; i < 50; i++) await store.addEdit("global", `fact ${i}`);
  await assert.rejects(store.addEdit("global", "one too many"), {
    message: memoryMessages.full,
  });
  // A generated summary folds in the global edits up to `second`.
  await store.saveDoc("global", {
    content: "Summary",
    source: "generated",
    baseRevision: 0,
    editsUpto: second.id,
  });
  const ids = store.current().edits.map((edit) => edit.id);
  assert.equal(ids.includes(first.id), false);
  assert.equal(ids.includes(second.id), false);
  assert.equal(ids.includes(project.id), true);
  await store.removeEdit(project.id);
  await store.removeEdit(project.id); // already gone: no error
  await store.setPrefs({ generate: true });
  await store.reset("global");
  assert.equal(store.current().docs.length, 0);
  assert.equal(store.current().edits.length, 0);
  assert.deepEqual(store.current().prefs, {
    searchChats: false,
    generate: true,
  });
});

test("an unreadable memory.json is never overwritten", async (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, "memory.json"), "{not json");
  const store = new LocalMemoryStore(root);
  assert.equal(store.unreadable, true);
  assert.deepEqual(store.current().docs, []);
  await assert.rejects(store.addEdit("global", "Likes tea"), {
    message: memoryMessages.broken,
  });
  assert.equal(
    fs.readFileSync(path.join(root, "memory.json"), "utf8"),
    "{not json",
  );
  assert.equal(exportedMemory(root), undefined);
});

// ----------------------------------------------------------- remote store

type Json = Record<string, any>;

/** The service's memory routes (internal/claudex/memory), in memory. */
function memoryService(
  options: {
    available?: boolean;
    reason?: string | null;
    allowed?: { search_chats: boolean; generate: boolean };
    missing?: boolean;
  } = {},
) {
  const state = {
    online: true,
    prefs: { search_chats: false, generate: false },
    docs: new Map<string, Json>(),
    edits: [] as Json[],
    nextEdit: 1,
    requests: [] as {
      method: string;
      url: string;
      headers: Json;
      body?: any;
    }[],
  };
  const iso = (n: number) => new Date(n * 1000).toISOString();
  const status = () => ({
    available: options.available ?? true,
    reason: options.reason ?? null,
    allowed: options.allowed ?? { search_chats: true, generate: true },
    prefs: state.prefs,
    prefs_set: true,
    effective: state.prefs,
    model: null,
  });
  const envelope = (data: unknown, http = 200) =>
    new Response(JSON.stringify({ code: 0, message: "ok", data }), {
      status: http,
      headers: { "content-type": "application/json" },
    });
  const error = (http: number, reason: string, metadata?: Json) =>
    new Response(
      JSON.stringify({ code: http, message: reason, reason, metadata }),
      { status: http },
    );
  const fetchImpl = async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.requests.push({
      method,
      url: url.pathname,
      headers: init.headers,
      body,
    });
    if (!state.online) throw new TypeError("fetch failed");
    if (options.missing)
      return new Response("404 page not found", { status: 404 });
    const route = url.pathname.replace("/api/v1/claudex", "");
    if (method === "GET" && route === "/memory")
      return envelope({
        ...status(),
        limits: {
          doc_bytes: 16384,
          edits_per_scope: 50,
          edit_chars: 500,
          scopes: 51,
        },
        docs: [...state.docs.values()],
        edits: state.edits,
      });
    if (method === "PUT" && route === "/memory/prefs") {
      state.prefs = { ...state.prefs, ...body };
      return envelope(status());
    }
    const docMatch = /^\/memory\/docs\/(.+)$/.exec(route);
    if (docMatch && method === "PUT") {
      const scope = decodeURIComponent(docMatch[1]);
      const current = state.docs.get(scope);
      if ((current?.revision ?? 0) !== body.base_revision)
        return error(409, "CLAUDEX_MEMORY_CONFLICT", {
          current_revision: String(current?.revision ?? 0),
        });
      const doc = {
        scope,
        content: body.content,
        readable: true,
        content_bytes: body.content.length,
        revision: (current?.revision ?? 0) + 1,
        source: body.source,
        generated_at: body.source === "generated" ? iso(50) : null,
        updated_at: iso(60),
        created_at: iso(10),
      };
      state.docs.set(scope, doc);
      return envelope(doc);
    }
    if (docMatch && method === "DELETE") {
      state.docs.delete(decodeURIComponent(docMatch[1]));
      return envelope({ deleted_docs: 1, deleted_edits: 0 });
    }
    if (method === "DELETE" && route === "/memory") {
      state.docs.clear();
      state.edits = [];
      return envelope({ deleted_docs: 1, deleted_edits: 1 });
    }
    if (method === "POST" && route === "/memory/edits") {
      if (/password/i.test(body.text))
        return error(422, "CLAUDEX_MEMORY_SENSITIVE");
      const edit = {
        id: state.nextEdit++,
        scope: body.scope,
        text: body.text,
        readable: true,
        created_at: iso(70),
      };
      state.edits.push(edit);
      return envelope(edit, 201);
    }
    const editMatch = /^\/memory\/edits\/(\d+)$/.exec(route);
    if (editMatch && method === "DELETE") {
      const before = state.edits.length;
      state.edits = state.edits.filter((e) => e.id !== Number(editMatch[1]));
      if (state.edits.length === before)
        return error(404, "CLAUDEX_MEMORY_EDIT_NOT_FOUND");
      return envelope({ deleted_edits: 1 });
    }
    return error(404, "NOT_FOUND_ROUTE");
  };
  return { state, fetchImpl };
}

function remoteStore(root: string, service: ReturnType<typeof memoryService>) {
  const api = new ClaudexMemory(
    "https://claudex.example.test",
    "6f1c2a4e-9b3d-4c8e-a1f2-3d4e5f6a7b8c",
    service.fetchImpl as typeof fetch,
  );
  return new RemoteMemoryStore(api, (call) => call("access"), root);
}

test("the remote store reads the service and keeps a 0600 cache for offline starts", async (t) => {
  const root = tempRoot(t);
  const service = memoryService();
  const store = remoteStore(root, service);
  assert.equal(store.current(), undefined);
  await store.load();
  const doc = await store.saveDoc("global", {
    content: "Likes tea.",
    source: "user",
    baseRevision: 0,
  });
  assert.equal(doc.revision, 1);
  assert.equal(doc.updatedAt, 60_000);
  const edit = await store.addEdit(`project:${projectId}`, "Uses Go");
  assert.equal(edit.id, "1");
  const post = service.state.requests.find((r) => r.method === "POST")!;
  assert.equal(post.headers.Authorization, "Bearer access");
  assert.equal(
    post.headers["X-Claudex-Device-Id"],
    "6f1c2a4e-9b3d-4c8e-a1f2-3d4e5f6a7b8c",
  );
  assert.deepEqual(post.body, {
    scope: `project:${projectId}`,
    text: "Uses Go",
  });
  const cache = path.join(root, memoryCacheFile);
  assert.equal(mode(cache), 0o600);
  // Offline: a new store starts from the cache and changes are refused.
  service.state.online = false;
  const offline = remoteStore(root, service);
  assert.equal(offline.current()!.docs[0].content, "Likes tea.");
  assert.equal(offline.current()!.edits[0].text, "Uses Go");
  await assert.rejects(offline.load(), MemoryOfflineError);
  await assert.rejects(
    offline.addEdit("global", "Lives in Berlin"),
    MemoryOfflineError,
  );
});

test("the remote store reports conflicts, refusals and a service without memory", async (t) => {
  const root = tempRoot(t);
  const service = memoryService();
  const store = remoteStore(root, service);
  await store.load();
  await store.saveDoc("global", {
    content: "a",
    source: "user",
    baseRevision: 0,
  });
  await assert.rejects(
    store.saveDoc("global", { content: "b", source: "user", baseRevision: 0 }),
    (error) =>
      error instanceof MemoryConflictError && error.currentRevision === 1,
  );
  await assert.rejects(store.addEdit("global", "password hunter2"), {
    message: memoryMessages.sensitive,
  });
  await store.removeEdit("99"); // already gone
  await store.removeEdit("not-a-number"); // never sent
  assert.equal(
    service.state.requests.filter((r) => r.url.includes("not-a-number")).length,
    0,
  );
  await store.reset();
  assert.equal(store.current()!.docs.length, 0);

  const old = remoteStore(tempRoot(t), memoryService({ missing: true }));
  await assert.rejects(old.load(), MemoryUnsupportedError);
});

test("service answers outside the contract are refused", () => {
  assert.throws(() => parseMemoryView({ available: true }), Sub2ApiError);
  assert.throws(
    () =>
      parseMemoryView({
        available: true,
        allowed: { search_chats: true, generate: true },
        prefs: { search_chats: false, generate: false },
        docs: [
          {
            scope: "project:../etc",
            content: "x",
            revision: 1,
            source: "user",
            updated_at: "2026-09-26T00:00:00Z",
          },
        ],
        edits: [],
      }),
    Sub2ApiError,
  );
  const unreadable = parseMemoryView({
    available: true,
    reason: null,
    allowed: { search_chats: true, generate: true },
    prefs: { search_chats: false, generate: true },
    docs: [
      {
        scope: "global",
        content: null,
        readable: false,
        revision: 3,
        source: "generated",
        generated_at: null,
        updated_at: "2026-09-26T00:00:00Z",
      },
    ],
    edits: [],
  });
  assert.equal(unreadable.docs[0].content, null);
  assert.deepEqual(
    parseMemoryBootstrap({
      available: false,
      reason: "server",
      allowed: { search_chats: true, generate: true },
      prefs: { search_chats: true, generate: false },
      prefs_set: false,
      effective: { search_chats: true, generate: false },
      model: "gpt-5",
      revision_by_scope: { global: 3 },
    }),
    {
      available: false,
      reason: "server",
      allowed: { searchChats: true, generate: true },
      prefs: { searchChats: true, generate: false },
      model: "gpt-5",
      revisions: { global: 3 },
    },
  );
  assert.equal(parseMemoryBootstrap({ available: true }), undefined);
  assert.equal(
    memoryError(
      new Sub2ApiError(403, "CLAUDEX_MEMORY_DISABLED", "x", {
        metadata: { field: "generate" },
      }),
    ).message,
    memoryMessages.switchDisabled,
  );
  assert.equal(
    memoryError(new Sub2ApiError(429, "RATE_LIMITED", "x")).message,
    memoryMessages.rateLimited,
  );
});

// --------------------------------------------------------------- service

const withMemory = (memory: Partial<NonNullable<ClientPolicy["memory"]>>) => ({
  ...openPolicy,
  memory: { ...openPolicy.memory!, ...memory },
});

test("the service combines the policy, the server and the person's switches", async (t) => {
  let policy: ClientPolicy = withMemory({});
  let changes = 0;
  const local = new MemoryService({
    store: new LocalMemoryStore(tempRoot(t)),
    policy: () => policy,
    changed: () => changes++,
  });
  await local.ready();
  assert.deepEqual(local.status(), {
    available: true,
    allowed: { searchChats: true, generate: true },
    prefs: { searchChats: false, generate: false },
    synthesizing: false,
  });
  assert.deepEqual(local.effective(), { searchChats: false, generate: false });
  // The administrator may make the switches start on.
  policy = withMemory({ defaultOn: true });
  assert.deepEqual(local.effective(), { searchChats: true, generate: true });
  policy = withMemory({ generate: false });
  await assert.rejects(local.setPrefs({ generate: true }), {
    message: memoryMessages.switchDisabled,
  });
  await local.setPrefs({ searchChats: true });
  assert.deepEqual(local.status().prefs, {
    searchChats: true,
    generate: false,
  });
  assert.equal(changes, 1);
  policy = withMemory({});
  await local.setPrefs({ generate: true });
  await local.saveDoc("global", "Likes tea", 0);
  await local.addEdit("global", "Lives in Berlin");
  const view = local.status().global!;
  assert.equal(view.content, "Likes tea");
  assert.equal(view.source, "edited");
  assert.equal(view.edits[0].text, "Lives in Berlin");
  await assert.rejects(
    local.saveDoc("global", "stale", 0),
    MemoryConflictError,
  );
  // Turned off by the administrator: nothing is used, data stays, deletes work.
  policy = withMemory({ enabled: false });
  assert.equal(local.status().reason, "policy");
  assert.equal(local.status().available, false);
  assert.deepEqual(local.effective(), { searchChats: false, generate: false });
  await assert.rejects(local.saveDoc("global", "x", 1), {
    message: memoryMessages.disabled,
  });
  assert.equal(local.memoryFor("global").doc?.content, "Likes tea");
  await local.removeEdit(view.edits[0].id);
  // An older service: no memory, every change refused.
  policy = { ...openPolicy, memory: undefined };
  assert.equal(local.status().reason, "unsupported");
  await assert.rejects(local.reset(), { message: memoryMessages.unsupported });
});

test("a Claudex account's memory follows the service, the cache and the pending policy", async (t) => {
  const root = tempRoot(t);
  const service = memoryService({
    allowed: { search_chats: true, generate: false },
  });
  let policy: ClientPolicy = withMemory({});
  const memory = new MemoryService({
    store: remoteStore(root, service),
    policy: () => policy,
    changed: () => {},
  });
  await memory.ready();
  // The server's policy is stricter than the cached client copy.
  assert.deepEqual(memory.status().allowed, {
    searchChats: true,
    generate: false,
  });
  await assert.rejects(memory.setPrefs({ generate: true }), {
    message: memoryMessages.switchDisabled,
  });
  policy = { ...withMemory({}), pending: true };
  await assert.rejects(memory.setPrefs({ searchChats: true }), {
    message: memoryMessages.pending,
  });
  policy = withMemory({});
  await memory.setPrefs({ searchChats: true });
  assert.deepEqual(service.state.prefs, {
    search_chats: true,
    generate: false,
  });
  // Offline: the cached copy, reason "offline", changes wait.
  service.state.online = false;
  await memory.refresh();
  assert.equal(memory.status().reason, "offline");
  assert.equal(memory.status().prefs.searchChats, true);
  await assert.rejects(
    memory.setPrefs({ searchChats: false }),
    MemoryOfflineError,
  );
  service.state.online = true;
  await memory.refresh();
  assert.equal(memory.status().available, true);

  // A server without its encryption key.
  const keyless = new MemoryService({
    store: remoteStore(
      tempRoot(t),
      memoryService({ available: false, reason: "server" }),
    ),
    policy: () => withMemory({}),
    changed: () => {},
  });
  await keyless.ready();
  assert.equal(keyless.status().reason, "server");
  await assert.rejects(keyless.saveDoc("global", "x", 0), {
    message: memoryMessages.serverKey,
  });
  // An older Claudex service without the memory component.
  const old = new MemoryService({
    store: remoteStore(tempRoot(t), memoryService({ missing: true })),
    policy: () => withMemory({}),
    changed: () => {},
  });
  await old.ready();
  assert.equal(old.status().reason, "server");
  assert.equal(old.supported, false);
});

test("a conflicting save reads memory again before it is reported", async (t) => {
  const root = tempRoot(t);
  const service = memoryService();
  const memory = new MemoryService({
    store: remoteStore(root, service),
    policy: () => withMemory({}),
    changed: () => {},
  });
  await memory.ready();
  await memory.saveDoc("global", "one", 0);
  // Another device writes revision 2.
  service.state.docs.set("global", {
    ...service.state.docs.get("global")!,
    content: "two",
    revision: 2,
  });
  await assert.rejects(
    memory.saveDoc("global", "mine", 1),
    MemoryConflictError,
  );
  assert.equal(memory.docView("global")!.content, "two");
  assert.equal(memory.docView("global")!.revision, 2);
  // The bootstrap's memory section asks for a read only when it differs.
  const same = {
    available: true,
    prefs: { searchChats: false, generate: false },
    revisions: { global: 2 },
  };
  assert.equal(memory.differsFrom(same), false);
  assert.equal(memory.differsFrom({ ...same, revisions: { global: 3 } }), true);
  assert.equal(
    memory.differsFrom({
      ...same,
      revisions: { global: 2, [`project:${projectId}`]: 1 },
    }),
    true,
  );
  assert.equal(
    memory.differsFrom({
      ...same,
      prefs: { searchChats: true, generate: false },
    }),
    true,
  );
});

// ------------------------------------------------------------ IPC domain

function fakeContext(root: string, policy: () => ClientPolicy) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const activated: ((account: PublicAccount) => void)[] = [];
  const deactivating: (() => void | Promise<void>)[] = [];
  const events: AppEvent[] = [];
  const extensions = new EngineExtensions();
  const ctx: any = {
    store: {
      root,
      projects: [{ id: projectId, name: "P" }],
      conversations: [],
      settings: { providers: [], activeProviderId: "" },
    },
    engine: { extensions, gatewayEndpoint: () => undefined },
    noActive: () => {},
    remote: undefined,
    services: {},
    policy,
    push: (event: AppEvent) => events.push(event),
    onAccountActivated: (cb: any) => (activated.push(cb), () => {}),
    onAccountDeactivating: (cb: any) => (deactivating.push(cb), () => {}),
    onWindowFocus: () => () => {},
    onEvent: () => () => {},
  };
  registerMemoryHandlers((name, fn) => handlers.set(name, fn), ctx);
  return {
    ctx,
    events,
    extensions,
    call: (name: string, ...args: unknown[]) => handlers.get(name)!(...args),
    activate: () => activated.forEach((cb) => cb({ id: "a" } as PublicAccount)),
    deactivate: () => Promise.all(deactivating.map((cb) => cb())),
  };
}

test("the IPC domain opens memory per account and validates what the window sends", async (t) => {
  const root = tempRoot(t);
  const env = fakeContext(root, () => withMemory({}));
  // Before sign-in: unsupported, nothing to change.
  assert.equal((await env.call("memoryStatus")).reason, "unsupported");
  await assert.rejects(env.call("resetMemory"), {
    message: memoryMessages.unsupported,
  });
  env.activate();
  assert.ok(env.ctx.services.memory?.service);
  assert.equal(env.extensions.has(memoryExtensionId), true);
  assert.equal((await env.call("memoryStatus")).available, true);
  await env.call("setMemoryPrefs", { generate: true });
  await assert.rejects(env.call("setMemoryPrefs", { generate: "yes" }));
  await assert.rejects(env.call("setMemoryPrefs", { other: true }));
  const doc = await env.call(
    "saveMemoryDoc",
    { kind: "project", projectId },
    "Go service",
    0,
  );
  assert.equal(doc.revision, 1);
  assert.equal(
    (await env.call("memoryDoc", { kind: "project", projectId })).content,
    "Go service",
  );
  assert.equal(await env.call("memoryDoc", { kind: "global" }), null);
  await assert.rejects(
    env.call(
      "saveMemoryDoc",
      { kind: "project", projectId: "1b4e28ba-2fa1-11d2-883f-0016d3cca428" },
      "x",
      0,
    ),
    { message: "Project not found." },
  );
  await assert.rejects(
    env.call("saveMemoryDoc", { kind: "project", projectId: "p1" }, "x", 0),
    { message: memoryMessages.noScope },
  );
  await assert.rejects(env.call("saveMemoryDoc", { kind: "global" }, "x", -1));
  // No model provider in this fake account: merging says so instead of guessing.
  await assert.rejects(
    env.call("previewMemoryImport", "from another assistant"),
    { message: "The model isn't available right now." },
  );
  const reset = await env.call("resetMemory", { kind: "project", projectId });
  assert.equal(reset.global, undefined);
  assert.ok(env.events.some((event) => event.type === "memory-changed"));
  await env.deactivate();
  assert.equal(env.ctx.services.memory, undefined);
  assert.equal(env.extensions.has(memoryExtensionId), false);
});

test("Manage memory adds and removes a scope's edits through one call", async (t) => {
  const root = tempRoot(t);
  const env = fakeContext(root, () => withMemory({}));
  env.activate();
  await env.call("setMemoryPrefs", { generate: true });
  const global = { kind: "global" };
  const added = await env.call("updateMemoryEdits", global, {
    add: "I like cats\nnot dogs",
  });
  // One line, kept beside the memory, with the service's limits.
  assert.deepEqual(
    added.edits.map((edit: { text: string }) => edit.text),
    ["I like cats not dogs"],
  );
  assert.deepEqual(added.limits, { edits: 50, editChars: 500 });
  assert.deepEqual(added.outcome, { kind: "added" });
  const second = await env.call("updateMemoryEdits", global, {
    add: "Broccoli is my favorite veg",
  });
  assert.equal(second.edits.length, 2);
  // A project's edit is not the global scope's to remove.
  const project = await env.call(
    "updateMemoryEdits",
    { kind: "project", projectId },
    { add: "Uses Go" },
  );
  const left = await env.call("updateMemoryEdits", global, {
    remove: [second.edits[0].id, project.edits[0].id],
  });
  assert.deepEqual(
    left.edits.map((edit: { text: string }) => edit.text),
    ["Broccoli is my favorite veg"],
  );
  // Only the scope's own edit went, and the result names it.
  assert.deepEqual(left.outcome, {
    kind: "removed",
    removed: ["I like cats not dogs"],
  });
  assert.equal(
    (await env.call("memoryDoc", { kind: "project", projectId })).edits.length,
    1,
  );
  // Nothing of the scope's was left to remove: nothing changed.
  assert.deepEqual(
    (
      await env.call("updateMemoryEdits", global, {
        remove: [project.edits[0].id],
      })
    ).outcome,
    { kind: "noop" },
  );
  // Clearing the last one leaves no memory for the scope.
  const cleared = await env.call("updateMemoryEdits", global, {
    remove: [left.edits[0].id],
  });
  assert.deepEqual(cleared.edits, []);
  assert.equal(cleared.content, "");
  assert.equal(cleared.outcome.kind, "removed");
  await assert.rejects(env.call("updateMemoryEdits", global, {}), {
    message: memoryMessages.emptyEdit,
  });
  // A secret is refused with a result, not an error, and nothing changes.
  await env.call("updateMemoryEdits", global, { add: "Likes tea" });
  const keep = (await env.call("memoryDoc", global)).edits[0].id;
  const secret = await env.call("updateMemoryEdits", global, {
    add: "api key = sk-abcdefghijk",
    remove: [keep],
  });
  assert.deepEqual(secret.outcome, { kind: "rejected" });
  assert.deepEqual(
    secret.edits.map((edit: { text: string }) => edit.text),
    ["Likes tea"],
  );
  const long = await env.call("updateMemoryEdits", global, {
    add: "x".repeat(501),
  });
  assert.deepEqual(long.outcome, { kind: "too_long", limit: 500 });
  const swapped = await env.call("updateMemoryEdits", global, {
    add: "Likes coffee",
    remove: [keep],
  });
  assert.deepEqual(swapped.outcome, {
    kind: "added_removed",
    removed: ["Likes tea"],
  });
  await env.call("updateMemoryEdits", global, {
    remove: [swapped.edits[0].id],
  });
  await assert.rejects(
    env.call("updateMemoryEdits", global, { add: "x", other: true }),
  );
  // Turned off: removing still works, adding does not.
  await env.call("updateMemoryEdits", global, { add: "Lives in Porto" });
  await env.call("setMemoryPrefs", { generate: false });
  await assert.rejects(env.call("updateMemoryEdits", global, { add: "More" }), {
    message: memoryMessages.off,
  });
  const doc = await env.call("memoryDoc", global);
  assert.equal(
    (
      await env.call("updateMemoryEdits", global, {
        remove: [doc.edits[0].id],
      })
    ).edits.length,
    0,
  );
  await env.deactivate();
});

test("the data export carries the account's memory", async (t) => {
  const root = tempRoot(t);
  const store = new LocalMemoryStore(root);
  await store.saveDoc("global", {
    content: "Likes tea",
    source: "user",
    baseRevision: 0,
  });
  await store.addEdit(`project:${projectId}`, "Uses Go");
  const entries = exportEntries({
    root,
    conversations: [],
    projects: [],
    settings: { mcpServers: {}, providers: [] } as any,
  });
  const entry = entries.find((item) => item.name === "memory.json")!;
  const exported = JSON.parse(entry.data.toString("utf8"));
  assert.equal(exported.documents[0].content, "Likes tea");
  assert.equal(exported.edits[0].text, "Uses Go");
  // A Claudex account: its cached copy.
  const remoteRoot = tempRoot(t);
  const remote = remoteStore(remoteRoot, memoryService());
  await remote.load();
  await remote.addEdit("global", "Lives in Berlin");
  assert.equal(exportedMemory(remoteRoot)!.edits[0].text, "Lives in Berlin");
  assert.equal(exportedMemory(tempRoot(t)), undefined);
});

test("a secret the model tries to remember never reaches the service", async (t) => {
  const root = tempRoot(t);
  const service = memoryService();
  service.state.prefs = { search_chats: false, generate: true };
  const memory = new MemoryService({
    store: remoteStore(root, service),
    policy: () => withMemory({}),
    changed: () => {},
  });
  await memory.ready();
  await assert.rejects(
    memory.addEdit("global", "My token is ghp_abcdefghijklmnopqrstuvwxyz0123"),
    { message: memoryMessages.sensitive },
  );
  assert.equal(
    service.state.requests.filter((r) => r.method === "POST").length,
    0,
  );
  // What is sent is the cleaned, one-line statement.
  await memory.addEdit("global", "Prefers\n  metric   units");
  assert.equal(service.state.edits[0].text, "Prefers metric units");
});
