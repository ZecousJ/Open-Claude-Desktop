/** F050 real adapter -> IPC -> MemoryService -> RemoteMemoryStore -> HTTP.
 * The loopback server supplies synthetic fixtures, not the production Go service.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { registerMemoryHandlers } from "../electron/ipc/memory";
import { MemoryService } from "../electron/memory/service";
import {
  RemoteMemoryStore,
  readMemoryCache,
} from "../electron/memory/remote-store";
import { ClaudexMemory } from "../electron/sub2api/claudex-memory";
import { memoryRoute } from "../electron/official-ui/api/memory";
import { organizationUuid } from "../electron/official-ui/api/context";
import { openPolicy } from "../shared/client-policy";

const projectId = "11111111-1111-4111-8111-111111111111";
const emptyId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const date = "2026-01-01T00:00:00.000Z";
function view(owner: string) {
  return {
    available: true,
    allowed: { search_chats: true, generate: true },
    prefs: { search_chats: true, generate: false },
    empty_controls_version: "v1:0:0:0",
    controls_versions: {
      global: "v1:1:0:0",
      [`project:${projectId}`]: "v1:2:0:0",
    },
    docs: ["global", `project:${projectId}`, `project:${otherId}`].map(
      (scope) => ({
        scope,
        content: `${owner}-${scope}`,
        revision: 1,
        source: "user",
        updated_at: date,
        created_at: date,
      }),
    ),
    edits: [
      {
        id: 1,
        scope: "global",
        text: `${owner} global edit`,
        created_at: date,
      },
      {
        id: 2,
        scope: `project:${projectId}`,
        text: `${owner} project edit`,
        created_at: date,
      },
    ],
  };
}
type ResponseMode = "success" | "offline" | "unsupported" | "malformed";
async function fixture(
  t: test.TestContext,
  responseMode: ResponseMode = "success",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f050-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const views = { A: view("A"), B: view("B") };
  const calls: string[] = [];
  const backend = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const owner =
      req.headers.authorization === "Bearer inert-A"
        ? "A"
        : req.headers.authorization === "Bearer inert-B"
          ? "B"
          : undefined;
    res.setHeader("content-type", "application/json");
    if (!owner) {
      res.writeHead(401);
      res.end(JSON.stringify({ code: "NO_AUTH" }));
      return;
    }
    if (req.method !== "GET" || req.url !== "/api/v1/claudex/memory") {
      res.writeHead(405);
      res.end("{}");
      return;
    }
    if (responseMode !== "success") {
      res.writeHead(
        responseMode === "offline"
          ? 503
          : responseMode === "unsupported"
            ? 404
            : 200,
      );
      res.end(
        JSON.stringify(
          responseMode === "malformed"
            ? { code: 0, data: { docs: "bad" } }
            : { code: "UNAVAILABLE" },
        ),
      );
      return;
    }
    res.end(JSON.stringify({ code: 0, data: views[owner] }));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(() => backend.close());
  const origin = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
  const profiles: Record<string, MemoryService> = {};
  for (const owner of ["A", "B"]) {
    const dir = path.join(root, owner);
    fs.mkdirSync(dir);
    const store = new RemoteMemoryStore(
      new ClaudexMemory(origin),
      (call) => call(`inert-${owner}`),
      dir,
    );
    const service = new MemoryService({
      store,
      policy: () => openPolicy,
      changed() {},
    });
    await service.ready();
    profiles[owner] = service;
    t.after(() => service.close());
  }
  const methods = new Map<string, (...args: unknown[]) => unknown>();
  const ctx: any = {
    store: {
      root: path.join(root, "A"),
      projects: [{ id: projectId }, { id: emptyId }],
      settings: {},
      isProjectDeleting: () => false,
    },
    services: { memory: { service: profiles.A } },
    activeAccount: { id: "A" },
    accountActivationIdentity: 1,
    accountRetiring: false,
    onAccountActivated() {},
    onAccountDeactivating() {},
    onEvent() {},
  };
  registerMemoryHandlers((name, fn) => methods.set(name, fn), ctx);
  let duringCall: (() => void) | undefined;
  const adapter: any = {
    readOnly: true,
    account: () => ctx.activeAccount,
    sessionIdentity: () => ctx.accountActivationIdentity,
    isCurrent: () => !ctx.accountRetiring,
    snapshot: async () => ({ projects: ctx.store.projects }),
    call: async (name: string, ...args: unknown[]) => {
      const result = await methods.get(name)!(...args);
      duringCall?.();
      return result;
    },
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
    calls,
    ctx,
    profiles,
    adapter,
    views,
    mode: (mode: typeof responseMode) => {
      responseMode = mode;
    },
    duringCall: (fn: () => void) => {
      duringCall = fn;
    },
    select(owner: "A" | "B") {
      ctx.activeAccount = { id: owner };
      ctx.accountActivationIdentity++;
      ctx.store = { ...ctx.store, root: path.join(root, owner) };
      ctx.services.memory = { service: profiles[owner] };
    },
    async get(suffix = "", owner = ctx.activeAccount.id) {
      const response = await fetch(
        `${base}${organizationUuid(owner)}/memory${suffix}`,
      );
      return { status: response.status, body: await response.json() };
    },
    call: (name: string, ...args: unknown[]) => methods.get(name)!(...args),
  };
}

test("remote HTTP reads preserve owner/scope, controls and empty-state without mutations", async (t) => {
  const f = await fixture(t);
  for (const owner of ["A", "B", "A"] as const) {
    f.select(owner);
    const global = await f.get();
    assert.equal(global.status, 200);
    assert.equal(global.body.memory, `${owner}-global`);
    assert.deepEqual(global.body.controls, [`${owner} global edit`]);
    assert.equal(global.body.controls_version, "v1:1:0:0");
    const project = await f.get(`?project_uuid=${projectId}`);
    assert.equal(project.status, 200);
    assert.equal(project.body.memory, `${owner}-project:${projectId}`);
    assert.deepEqual(project.body.controls, [`${owner} project edit`]);
    assert.equal(project.body.controls_version, "v1:2:0:0");
    const empty = await f.get(`?project_uuid=${emptyId}`);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.memory, "");
    assert.equal(empty.body.updated_at, null);
    assert.deepEqual(empty.body.controls, []);
    assert.equal(empty.body.controls_version, "v1:0:0:0");
    assert.equal((await f.get(`?project_uuid=${otherId}`)).status, 404);
    assert.equal((await f.get("", owner === "A" ? "B" : "A")).status, 404);
    assert.equal(
      (await f.get(`/settings`)).body.claudex_memory.snapshot.memory,
      `${owner}-global`,
    );
    assert.equal(
      (await f.get(`?project_uuid=${projectId}&project_uuid=${emptyId}`))
        .status,
      400,
    );
    assert.equal((await f.get("?unknown=1")).status, 400);
  }
  assert.ok(f.calls.every((call) => call === "GET /api/v1/claudex/memory"));
  for (const owner of ["A", "B"]) {
    const cached = readMemoryCache(path.join(f.root, owner))!;
    assert.ok(cached.docs.every((doc) => doc.content?.startsWith(`${owner}-`)));
    assert.equal(
      fs.statSync(path.join(f.root, owner, "memory-cache.json")).mode & 0o777,
      0o600,
    );
  }
});

for (const mode of ["offline", "unsupported", "malformed"] as const)
  test(`${mode} remote reads fail closed and retry without a host refresh`, async (t) => {
    const f = await fixture(t);
    f.mode(mode);
    for (const suffix of ["", `?project_uuid=${projectId}`]) {
      const result = await f.get(suffix);
      assert.equal(result.status, mode === "unsupported" ? 501 : 503);
      assert.doesNotMatch(JSON.stringify(result.body), /A-global|A-project/);
    }
    const cached = readMemoryCache(path.join(f.root, "A"))!;
    assert.ok(cached.docs.every((doc) => doc.content?.startsWith("A-")));
    f.mode("success");
    assert.equal((await f.get()).body.memory, "A-global");
    assert.equal(
      (await f.get(`?project_uuid=${projectId}`)).body.memory,
      `A-project:${projectId}`,
    );
    assert.ok(f.calls.every((call) => call === "GET /api/v1/claudex/memory"));
  });

test("the first document read after a cold offline activation recovers without publishing memory", async (t) => {
  const f = await fixture(t, "offline");
  assert.equal(f.profiles.A.status().reason, "offline");
  assert.equal((await f.get()).status, 503);
  f.mode("success");
  f.adapter.readMemorySettings = () => f.profiles.A.readSettings();
  const settings = await f.get("/settings");
  assert.equal(settings.status, 200);
  assert.equal(settings.body.claudex_memory.available, true);
  assert.equal(settings.body.claudex_memory.snapshot.memory, "A-global");
  assert.equal((await f.get()).body.memory, "A-global");
  assert.equal(
    (await f.get(`?project_uuid=${projectId}`)).body.memory,
    `A-project:${projectId}`,
  );
  assert.equal(f.profiles.A.status().reason, "offline");
  assert.equal(readMemoryCache(path.join(f.root, "A")), undefined);
});

test("reopening either scope reads another device's document and controls from the same version", async (t) => {
  const f = await fixture(t);
  for (const [index, suffix] of ["", `?project_uuid=${projectId}`].entries()) {
    const original = await f.get(suffix);
    const remote = f.views.A;
    const scope = remote.docs[index].scope;
    remote.docs[index].content = `Revised ${scope}`;
    remote.docs[index].revision++;
    remote.edits[index].text = `New control for ${scope}`;
    const versions: Record<string, string> = remote.controls_versions;
    versions[scope] = `v1:${index + 1}:0:1`;
    remote.prefs.generate = true;
    const current = await f.get(suffix);
    assert.equal(current.status, 200);
    assert.equal(current.body.memory, remote.docs[index].content);
    assert.deepEqual(current.body.controls, [remote.edits[index].text]);
    assert.equal(current.body.controls_version, versions[scope]);
    assert.notEqual(
      current.body.controls_version,
      original.body.controls_version,
    );
  }
  assert.equal(f.profiles.A.status().prefs.generate, false);
  assert.equal(
    readMemoryCache(path.join(f.root, "A"))!.docs[0].content,
    "A-global",
  );
});

test("project deletion during import metadata lookup prevents a Classic read", async (t) => {
  const f = await fixture(t);
  f.adapter.melange = async () => ({
    read: async () => ({ mode: "melange" }),
    importStatus: async () => {
      f.ctx.store.projects = [];
      return { status: "pending" };
    },
  });
  const result = await f.get(
    `?project_uuid=${projectId}&include_project_import=true`,
  );
  assert.equal(result.status, 404);
  assert.doesNotMatch(JSON.stringify(result.body), /A-project/);
});

test("account reactivation during import metadata lookup prevents a Classic read", async (t) => {
  const f = await fixture(t);
  f.adapter.melange = async () => ({
    read: async () => {
      f.select("A");
      return { mode: "classic" };
    },
  });
  const result = await f.get(
    `?project_uuid=${projectId}&include_project_import=true`,
  );
  assert.equal(result.status, 409);
  assert.doesNotMatch(JSON.stringify(result.body), /A-project/);
});

test("late same-owner activation cannot return an earlier HTTP read", async (t) => {
  const f = await fixture(t);
  f.duringCall(() => f.ctx.accountActivationIdentity++);
  const result = await f.get(`?project_uuid=${projectId}`);
  assert.equal(result.status, 409);
  assert.equal(JSON.stringify(result.body).includes("A-project"), false);
});

test("project removed from current profile cannot be read from retained remote cache", async (t) => {
  const f = await fixture(t);
  const before = f.calls.length;
  f.ctx.store.projects = [];
  assert.equal((await f.get(`?project_uuid=${projectId}`)).status, 404);
  await assert.rejects(
    f.call("memoryDoc", { kind: "project", projectId }) as Promise<unknown>,
    /Project not found/,
  );
  assert.equal(f.calls.length, before);
  assert.equal((await f.get()).body.memory, "A-global");
});

test("project removed after IPC resolves cannot escape through the adapter await boundary", async (t) => {
  const f = await fixture(t);
  f.duringCall(() => {
    f.ctx.store.projects = [];
  });
  const result = await f.get(`?project_uuid=${projectId}`);
  assert.equal(result.status, 404);
  assert.equal(JSON.stringify(result.body).includes("A-project"), false);
});
