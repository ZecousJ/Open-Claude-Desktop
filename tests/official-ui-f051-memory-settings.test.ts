/** Real adapter/IPC/service/client HTTP chain. Loopback fixture, not production backend. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { MemoryService } from "../electron/memory/service";
import {
  RemoteMemoryStore,
  readMemoryCache,
} from "../electron/memory/remote-store";
import { ClaudexMemory } from "../electron/sub2api/claudex-memory";
import { registerMemoryHandlers } from "../electron/ipc/memory";
import { memoryRoute } from "../electron/official-ui/api/memory";
import { organizationUuid } from "../electron/official-ui/api/context";
import { openPolicy } from "../shared/client-policy";
async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f051-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const states = Object.fromEntries(
    ["A", "B"].map((owner) => [
      owner,
      {
        available: true,
        allowed: { generate: true, search_chats: true },
        prefs: { generate: true, search_chats: true },
        docs: [
          {
            scope: "global",
            content: `${owner} synthetic memory`,
            source: "user",
            revision: 1,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        edits: [],
      },
    ]),
  );
  let mode: "success" | "offline" | "policy" | "malformed" = "success";
  const calls: { owner: string; method: string; url: string; body: any }[] = [];
  const backend = http.createServer(async (req, res) => {
    const owner = req.headers.authorization === "Bearer inert-A" ? "A" : "B";
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    calls.push({ owner, method: req.method!, url: req.url!, body });
    res.setHeader("content-type", "application/json");
    if (req.method === "PUT") {
      if (mode !== "success") {
        res.writeHead(mode === "offline" ? 503 : mode === "policy" ? 403 : 200);
        res.end(
          JSON.stringify(
            mode === "malformed"
              ? { code: 0, data: { prefs: "bad" } }
              : {
                  code: mode === "policy" ? "MEMORY_DISABLED" : "UNREACHABLE",
                  message: "synthetic rejection",
                },
          ),
        );
        return;
      }
      if (req.url !== "/api/v1/claudex/memory/prefs") {
        res.writeHead(405);
        res.end("{}");
        return;
      }
      Object.assign(states[owner].prefs, body);
    } else if (req.method !== "GET" || req.url !== "/api/v1/claudex/memory") {
      res.writeHead(405);
      res.end("{}");
      return;
    }
    res.end(JSON.stringify({ code: 0, data: states[owner] }));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(() => backend.close());
  const origin = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
  const services: Record<string, MemoryService> = {};
  const make = async (owner: string) => {
    const dir = path.join(root, owner);
    fs.mkdirSync(dir, { recursive: true });
    const service = new MemoryService({
      store: new RemoteMemoryStore(
        new ClaudexMemory(origin),
        (call) => call(`inert-${owner}`),
        dir,
      ),
      policy: () => openPolicy,
      changed() {},
    });
    await service.ready();
    services[owner] = service;
    t.after(() => service.close());
    return service;
  };
  for (const owner of ["A", "B"]) await make(owner);
  const ctx: any = {
    store: { root: path.join(root, "A"), settings: {}, projects: [] },
    services: { memory: { service: services.A } },
    activeAccount: { id: "A" },
    accountActivationIdentity: 1,
    accountRetiring: false,
    onAccountActivated() {},
    onAccountDeactivating() {},
    onEvent() {},
  };
  const methods = new Map<string, (...args: any[]) => any>();
  registerMemoryHandlers((name, fn) => methods.set(name, fn), ctx);
  const adapter: any = {
    account: () => ctx.activeAccount,
    sessionIdentity: () => ctx.accountActivationIdentity,
    isCurrent: () => !ctx.accountRetiring,
    snapshot: async () => ({ projects: [] }),
    readOnly: false,
    memoryPreferenceActions: () => ctx.services.memory.service.preferenceActions(),
    call: (name: string, ...args: any[]) => methods.get(name)!(...args),
  };
  const host = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    void memoryRoute(req, res, url.pathname, url, adapter);
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  t.after(() => host.close());
  const base = `http://127.0.0.1:${(host.address() as { port: number }).port}/api/organizations/`;
  return {
    root,
    states,
    services,
    calls,
    adapter,
    mode: (value: typeof mode) => {
      mode = value;
    },
    select(owner: string) {
      ctx.activeAccount = { id: owner };
      ctx.accountActivationIdentity++;
      ctx.store = { ...ctx.store, root: path.join(root, owner) };
      ctx.services.memory = { service: services[owner] };
    },
    async reopen(owner: string) {
      services[owner].close();
      await make(owner);
      ctx.services.memory = { service: services[owner] };
      ctx.accountActivationIdentity++;
    },
    async request(
      suffix = "settings",
      body?: unknown,
      owner = ctx.activeAccount.id,
    ) {
      const response = await fetch(
        `${base}${organizationUuid(owner)}/memory/${suffix}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      return { status: response.status, body: await response.json() };
    },
  };
}
test("both switch combinations persist through the real HTTP chain and reopen without deleting memory", async (t) => {
  const f = await fixture(t);
  for (const [generate, search] of [
    [false, true],
    [false, false],
    [true, false],
    [true, true],
  ]) {
    const r = await f.request("settings", {
      enabled_saffron: generate,
      enabled_saffron_search: search,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled_saffron, generate);
    assert.equal(r.body.claudex_memory.generation_action, "available");
    assert.equal(r.body.enabled_saffron_search, search);
    await f.reopen("A");
    const restored = await f.request();
    assert.equal(restored.body.claudex_memory.generation_action, "available");
    assert.deepEqual(restored.body.claudex_memory.preferences, {
      generate,
      searchChats: search,
    });
    assert.equal(
      readMemoryCache(path.join(f.root, "A"))!.docs[0].content,
      "A synthetic memory",
    );
  }
  assert.ok(f.calls.every((c) => ["GET", "PUT"].includes(c.method)));
});
test("disable-only preserves search and does not refresh, reset, or enable generation", async (t) => {
  const f = await fixture(t);
  const before = f.calls.length;
  const r = await f.request("disable-generation", { enabled: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.claudex_memory.preferences, {
    generate: false,
    searchChats: true,
  });
  assert.deepEqual(f.calls.slice(before), [
    {
      owner: "A",
      method: "PUT",
      url: "/api/v1/claudex/memory/prefs",
      body: { generate: false },
    },
  ]);
});
test("account settings remain separate on switch and reopen", async (t) => {
  const f = await fixture(t);
  await f.request("settings", { enabled_saffron_search: false });
  f.select("B");
  assert.deepEqual((await f.request()).body.claudex_memory.preferences, {
    generate: true,
    searchChats: true,
  });
  await f.request("disable-generation", { enabled: false });
  f.select("A");
  await f.reopen("A");
  assert.deepEqual((await f.request()).body.claudex_memory.preferences, {
    generate: true,
    searchChats: false,
  });
  assert.equal(
    (await f.request("settings", { enabled_saffron: true }, "B")).status,
    404,
  );
});
for (const mode of ["offline", "policy", "malformed"] as const)
  test(`${mode} write cannot acknowledge or persist success and later retry recovers`, async (t) => {
    const f = await fixture(t);
    f.mode(mode);
    const r = await f.request("settings", { enabled_saffron_search: false });
    assert.ok(r.status >= 400);
    assert.deepEqual(f.states.A.prefs, { generate: true, search_chats: true });
    assert.deepEqual(readMemoryCache(path.join(f.root, "A"))!.prefs, {
      generate: true,
      searchChats: true,
    });
    const readsBeforeRetry = f.calls.filter(
      ({ method }) => method === "GET",
    ).length;
    const saved = await f.request();
    assert.equal(saved.status, 200);
    assert.equal(saved.body.enabled_saffron_search, true);
    f.mode("success");
    assert.equal(
      (await f.request("settings", { enabled_saffron_search: false })).status,
      200,
    );
    assert.equal(f.states.A.prefs.search_chats, false);
    assert.equal(
      f.calls.filter(({ method }) => method === "GET").length,
      readsBeforeRetry,
    );
  });
test("unsupported and Web writes are rejected before service mutation", async (t) => {
  const f = await fixture(t);
  const before = f.calls.length;
  for (const body of [
    { enabled_melange: true },
    { enabled_saffron: "false" },
    { unknown: true },
    { clear_data: true },
    { enabled_saffron: false, clear_data: true },
  ])
    assert.equal((await f.request("settings", body)).status, 400);
  f.adapter.readOnly = true;
  assert.equal(
    (await f.request("settings", { enabled_saffron_search: false })).status,
    501,
  );
  assert.equal(
    (await f.request("disable-generation", { enabled: false })).status,
    501,
  );
  assert.equal(f.calls.length, before);
});
test("Web settings read current account preferences and policy without changing the memory service snapshot", async (t) => {
  const f = await fixture(t);
  f.adapter.readOnly = true;
  f.adapter.readMemorySettings = () => f.services.A.readSettings();
  f.states.A.allowed.generate = false;
  f.states.A.allowed.search_chats = false;
  f.states.A.prefs.search_chats = false;

  const settings = await f.request();
  assert.equal(settings.status, 200);
  assert.equal(settings.body.enabled_saffron, false);
  assert.equal(settings.body.enabled_saffron_search, false);
  assert.deepEqual(settings.body.claudex_memory.allowed, {
    generate: false,
    searchChats: false,
  });
  assert.deepEqual(settings.body.claudex_memory.preferences, {
    generate: true,
    searchChats: false,
  });
  assert.notEqual(settings.body.claudex_memory.generation_action, "available");
  assert.deepEqual(f.services.A.status().allowed, {
    generate: true,
    searchChats: true,
  });
  assert.deepEqual(f.services.A.status().prefs, {
    generate: true,
    searchChats: true,
  });
});
