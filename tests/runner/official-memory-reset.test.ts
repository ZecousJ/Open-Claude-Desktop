import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AppContext, IpcHandle } from "../../electron/app/app-context";
import { registerMemoryHandlers } from "../../electron/ipc/memory";
import { CoworkMemoryFiles } from "../../electron/memory/cowork-files";
import { readMemoryCache, RemoteMemoryStore } from "../../electron/memory/remote-store";
import { MemoryService } from "../../electron/memory/service";
import type { MelangeSnapshot, MelangeState } from "../../electron/memory/melange";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { ClaudexMemory } from "../../electron/sub2api/claudex-memory";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import { officialUiRead } from "../../runner/src/official-ui-read";
import type { WebAppContext } from "../../runner/src/web-app-context";
import { openPolicy } from "../../shared/client-policy";
import { officialMemoryCapabilitiesPath } from "../../shared/official-memory-capability";
import type { OfficialUiReadRequest, OfficialUiReadResponse } from "../../shared/official-ui-web";
import { negotiatedMemoryAction } from "../../src-web/official/negotiated-memory-action";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProject = "22222222-2222-4222-8222-222222222222";
const projectScope = `project:${projectId}`;
const otherScope = `project:${otherProject}`;
const accountId = "owner";
const browserAccount = "7";
const origin = "https://app.fixture.invalid";
const memoryPath = `/api/organizations/${organizationUuid(accountId)}/memory`;
const resetPath = memoryPath + "/reset";
const settingsPath = memoryPath + "/settings";
const clearSettings = { enabled_saffron: false, enabled_melange: false, clear_data: true, user_initiated: true };

async function fixture(t: TestContext, initial: {
  generate: boolean;
  searchChats: boolean;
  melange?: MelangeState;
} = { generate: true, searchChats: true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f052-remote-memory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = new CoworkMemoryFiles(root);
  cwd.save("kept.md", "Independent Cowork memory");
  const docs = new Map([
    ["global", "Global memory"],
    [projectScope, "Project memory"],
    [otherScope, "Other project memory"],
  ]);
  const edits = new Map([...docs].map(([scope], i) => [scope, { id: i + 1, text: `Rule ${i + 1}` }]));
  let generate = initial.generate, searchChats = initial.searchChats;
  let melange: MelangeSnapshot = { revision: 0, state: initial.melange ?? null };
  let allowed = { generate: true, search_chats: true };
  let reason: "server" | undefined;
  let policy = openPolicy;
  let epoch = 0, rejectDelete = false, ignorePrefs = false, rejectReadback = false;
  const prefs = () => ({ generate, search_chats: searchChats });
  const status = () => ({
    available: !reason, reason, allowed, prefs: prefs(), model: null,
  });
  const wire = (data: unknown, status = 200) => Response.json(
    status === 200 ? { code: 0, data } : { code: status, message: "Fixture memory service rejected the operation." },
    { status },
  );
  const requests: string[] = [];
  const preferenceWrites: unknown[] = [];
  const api = new ClaudexMemory("https://memory.fixture.invalid", "33333333-3333-4333-8333-333333333333",
    async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.headers.get("authorization"), "Bearer inert-access");
      const base = "/api/v1/claudex/memory";
      const route = new URL(request.url).pathname;
      requests.push(`${request.method} ${route}`);
      if (request.method === "GET" && route === base && rejectReadback && epoch > 0) return wire(null, 500);
      if (request.method === "GET" && route === base) return wire({
        ...status(),
        empty_controls_version: `v1:${epoch}:0:0`,
        docs: [...docs].map(([scope, content]) => ({
          scope, content, source: "user", revision: 1, updated_at: "2026-01-01T00:00:00Z",
        })),
        edits: [...edits].map(([scope, edit]) => ({ ...edit, scope, created_at: "2026-01-01T00:00:00Z" })),
      });
      if (request.method === "DELETE" && (route === base || route.startsWith(base + "/docs/"))) {
        if (rejectDelete) return wire(null, 500);
        const scopes = route === base ? [...docs.keys()] : [decodeURIComponent(route.slice((base + "/docs/").length))];
        for (const scope of scopes) {
          docs.delete(scope);
          edits.delete(scope);
        }
        epoch++;
        return wire({ deleted_docs: scopes.length, deleted_edits: scopes.length });
      }
      if (request.method === "PUT" && route === base + "/prefs") {
        const patch = await request.json();
        preferenceWrites.push(patch);
        if (patch.generate === true && !allowed.generate || patch.search_chats === true && !allowed.search_chats)
          return wire(null, 403);
        if (!ignorePrefs) {
          generate = patch.generate ?? generate;
          searchChats = patch.search_chats ?? searchChats;
        }
        return wire(status());
      }
      throw Error(`Unexpected memory request ${request.method} ${route}`);
    });
  const service = new MemoryService({
    store: new RemoteMemoryStore(api, (run) => run("inert-access"), root),
    policy: () => policy, changed() {},
  });
  t.after(() => service.close());
  await service.ready();
  assert.equal(service.status().available, true);
  const melangePath = "/api/v1/claudex/memory/melange";
  const melangeRequest: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname !== melangePath) throw Error("Unexpected classified memory request.");
    requests.push(`${request.method} ${melangePath}`);
    if (request.method === "GET") return wire(melange);
    const { base_revision, state } = await request.json() as { base_revision: number; state: MelangeState };
    assert.equal(request.method, "PUT");
    assert.equal(base_revision, melange.revision);
    if (melange.state?.mode !== state.mode) generate = state.mode === "classic";
    melange = { revision: base_revision + 1, state };
    return wire(melange);
  };
  if (initial.melange) {
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input)).hostname === "classified-memory.fixture.invalid" ? melangeRequest(input, init) : fetch(input, init));
  }
  let identity = 1;
  const projects = [{ id: projectId }];
  const handlers = new Map<string, Parameters<IpcHandle>[1]>();
  const ctx = {
    userId: 7,
    activeAccount: { id: accountId },
    officialSessionIdentity: () => identity,
    get accountActivationIdentity() { return identity; },
    setAccessToken() {},
    onEvent: () => () => {},
    onAccountActivated: () => () => {},
    onAccountDeactivating: () => () => {},
    ...(initial.melange && { remote: {
      claudex: {},
      accounts: { baseUrl: "https://classified-memory.fixture.invalid" },
      session: { authorized: (run: (token: string) => Promise<unknown>) => run("inert-access") },
      backend: { deviceId: "33333333-3333-4333-8333-333333333333" },
    } }),
    services: { memory: { service } },
    store: { root, settings: { providers: [] }, projects, isProjectDeleting: () => false },
    appVersion: "inert",
    log() {},
  };
  registerMemoryHandlers((name, handler) => handlers.set(name, handler), ctx as unknown as AppContext);
  const dispatcher = {
    options: { officialUiRoot: path.resolve("build/official-ui"), officialUiActions: true },
    guard: { modes: ["chat"] },
    context: () => ctx as unknown as WebAppContext,
    contextFor: async () => ctx as unknown as WebAppContext,
    now: () => 1,
    run: async (frame: CallFrame) => {
      if (frame.method === "snapshot") return { projects };
      const handler = handlers.get(frame.method);
      if (!handler) throw Error("Unexpected memory method " + frame.method);
      return handler(...(decodeWireValue(frame.args) as unknown[]));
    },
  };
  const run = (method: CallFrame["method"], request: OfficialUiReadRequest) =>
    officialUiRead(dispatcher as unknown as Dispatcher, {
      t: "call", id: "fixture", user: { id: 7, accessToken: "inert-relay" }, method, deadlineMs: 1,
      args: encodeWireValue([request]) as unknown[],
    });
  const capability = async () => json(await run("officialUiRead", { method: "GET", path: officialMemoryCapabilitiesPath }));
  const action = negotiatedMemoryAction({
    accountId: browserAccount, enabled: false, current: () => true,
    read: request => run("officialUiRead", request),
    action: request => run("officialUiAction", request),
  });
  const fetchOfficial = createOfficialReadFetch(origin, request => run("officialUiRead", request),
    async () => { throw Error("Unexpected external fetch"); }, undefined, action);
  const post = (path: string, body?: unknown) => fetchOfficial(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return {
    root, cwd, docs, edits, prefs, preferenceWrites, requests, run, capability, post, dispatcher, fetchOfficial,
    melange: () => melange,
    async setServerPolicy(next: typeof allowed, unavailable?: typeof reason) {
      allowed = next;
      reason = unavailable;
      await service.refresh();
    },
    setPolicyPending() { policy = { ...policy, pending: true }; },
    rejectDelete(value: boolean) { rejectDelete = value; },
    ignorePrefs() { ignorePrefs = true; },
    rejectReadback() { rejectReadback = true; },
    rotate() { identity++; },
  };
}

const json = (response: OfficialUiReadResponse) => JSON.parse(Buffer.from(response.body).toString());
const deleteRequests = (requests: string[]) => requests.filter(request => request.startsWith("DELETE "));

test("Web reset follows the bodyless all-memory contract and preserves explicit global and project scopes", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.capability()).reset, "ready");
  assert.equal((await f.capability()).settings, "disable-only");
  assert.equal((await f.capability()).controls.reason, "disabled");
  let response = await f.post(resetPath, { project_uuid: projectId });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    memory: "", controls: [], updated_at: null, controls_version: "v1:1:0:0",
    project_import: null, project_memory_mode: null,
    cleared_scope: { kind: "project", projectId },
  });
  assert.deepEqual([...f.docs.keys()], ["global", otherScope]);
  assert.deepEqual([...f.edits.keys()], ["global", otherScope]);
  response = await f.post(resetPath, {});
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).cleared_scope, { kind: "global" });
  assert.deepEqual([...f.docs.keys()], [otherScope]);
  response = await f.post(resetPath);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).cleared_scope, { kind: "all" });
  assert.deepEqual(deleteRequests(f.requests), [
    `DELETE /api/v1/claudex/memory/docs/project%3A${projectId}`,
    "DELETE /api/v1/claudex/memory/docs/global",
    "DELETE /api/v1/claudex/memory",
  ]);
  assert.equal(f.docs.size, 0);
  assert.equal(f.edits.size, 0);
  assert.equal(readMemoryCache(f.root)?.docs.length, 0);
  assert.equal(f.cwd.read("kept.md")?.content, "Independent Cowork memory");
  assert.deepEqual(f.prefs(), { generate: true, search_chats: true });
});

test("Web reset rejects foreign or ambiguous scopes and retired leases before deletion", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post(resetPath.replace(organizationUuid(accountId), organizationUuid("foreign")))).status, 404);
  assert.equal((await f.post(resetPath, { project_uuid: otherProject })).status, 404);
  assert.equal((await f.post(resetPath, { project_uuid: null })).status, 400);
  assert.equal((await f.post(resetPath, { project_id: projectId })).status, 400);
  assert.equal((await f.post(resetPath + "?project_uuid=")).status, 404);
  assert.equal((await f.post(resetPath + `?project_uuid=${projectId}`, { project_uuid: otherProject })).status, 400);
  const lease = (await f.capability()).activationLease;
  f.rotate();
  assert.equal((await f.run("officialUiAction", { method: "POST", path: resetPath, capabilityLease: lease })).status, 409);
  f.dispatcher.options.officialUiActions = false;
  assert.equal((await f.post(resetPath)).status, 501);
  assert.deepEqual(deleteRequests(f.requests), []);
  assert.equal(f.docs.size, 3);
  assert.equal(f.edits.size, 3);
});

test("a failed service deletion keeps memory and preferences, and an explicit retry clears them", async (t) => {
  const f = await fixture(t);
  const before = await f.fetchOfficial(settingsPath);
  assert.equal((await before.json()).claudex_memory.reset_action, "available");
  f.rejectDelete(true);
  assert.equal((await f.post(settingsPath, clearSettings)).status, 503);
  assert.equal(f.docs.size, 3);
  assert.equal(f.edits.size, 3);
  assert.equal(readMemoryCache(f.root)?.docs.length, 3);
  assert.deepEqual(f.prefs(), { generate: true, search_chats: true });
  assert.equal(f.requests.some(request => request.startsWith("PUT ")), false);
  f.rejectDelete(false);
  const result = await f.post(settingsPath, clearSettings);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).complete, true);
  assert.equal(f.docs.size, 0);
  assert.equal(f.edits.size, 0);
  assert.deepEqual(f.prefs(), { generate: false, search_chats: true });
});

test("Web settings require the original gestures and pause without deleting memory", async (t) => {
  const f = await fixture(t);
  for (const body of [{}, { enabled_saffron: true }, { enabled_saffron_search: false },
    { enabled_saffron: false, clear_data: true }, { enabled_saffron: false, enabled_melange: true }])
    assert.equal((await f.post(settingsPath, body)).status, 400);
  const paused = await f.post(settingsPath, { enabled_saffron: false });
  assert.equal(paused.status, 200);
  assert.equal(f.docs.size, 3);
  assert.deepEqual(deleteRequests(f.requests), []);
  assert.deepEqual(f.preferenceWrites, [{ generate: false }]);
  assert.deepEqual(f.prefs(), { generate: false, search_chats: true });
  const retry = await fixture(t);
  retry.ignorePrefs();
  const failed = await retry.post(settingsPath, clearSettings);
  assert.equal(failed.status, 503);
  assert.match((await failed.json()).error.message, /Memory was cleared/);
  assert.equal(retry.docs.size, 0);
  assert.deepEqual(retry.prefs(), { generate: true, search_chats: true });
});

test("Web Classic and chat search settings persist independently through the account memory backend", async (t) => {
  const f = await fixture(t, { generate: false, searchChats: false });
  const backfillPath = memoryPath.replace(/memory$/, "conversation/backfill");
  assert.deepEqual((await f.capability()).preferences, { generate: true, searchChats: true });
  const initial = await (await f.fetchOfficial(settingsPath)).json();
  assert.equal(initial.memory_mode, "off");
  assert.equal(initial.enabled_saffron_search, false);
  assert.equal(initial.claudex_memory.generation_action, "available");
  assert.equal(initial.claudex_memory.search_action, "available");
  const requestCount = f.requests.length;
  assert.equal((await f.post(backfillPath, {})).status, 204);
  assert.equal((await f.post(backfillPath, { project_uuid: projectId })).status, 400);
  assert.equal(f.requests.length, requestCount);
  const search = await f.post(settingsPath, { enabled_saffron_search: true, user_initiated: true });
  assert.equal(search.status, 200);
  const searched = await search.json();
  assert.equal(searched.memory_mode, "off");
  assert.equal(searched.enabled_saffron_search, true);
  assert.deepEqual(searched.claudex_memory.preferences, { generate: false, searchChats: true });
  assert.deepEqual(f.preferenceWrites, [{ search_chats: true }]);
  const classic = await f.post(settingsPath, { enabled_saffron: true, user_initiated: true });
  assert.equal(classic.status, 200);
  const enabled = await classic.json();
  assert.equal(enabled.memory_mode, "classic");
  assert.equal(enabled.claudex_memory.generation_action, "available");
  assert.equal(enabled.claudex_memory.generation_disable_action, "available");
  assert.deepEqual(enabled.claudex_memory.preferences, { generate: true, searchChats: true });
  const searchOff = await f.post(settingsPath, { enabled_saffron_search: false, user_initiated: true });
  assert.equal(searchOff.status, 200);
  assert.equal((await searchOff.json()).memory_mode, "classic");
  assert.deepEqual((await (await f.fetchOfficial(settingsPath)).json()).claudex_memory.preferences,
    { generate: true, searchChats: false });
  assert.deepEqual(f.preferenceWrites, [{ search_chats: true }, { generate: true }, { search_chats: false }]);
  assert.equal(f.docs.size, 3);
});

test("search-only policy and missing server encryption do not expose Classic generation", async (t) => {
  const f = await fixture(t, { generate: false, searchChats: false });
  await f.setServerPolicy({ generate: true, search_chats: true }, "server");
  assert.deepEqual((await f.capability()).preferences, { generate: false, searchChats: true });
  assert.equal((await f.post(settingsPath, { enabled_saffron: true, user_initiated: true })).status, 501);
  const search = await f.post(settingsPath, { enabled_saffron_search: true, user_initiated: true });
  assert.equal(search.status, 200);
  const data = await search.json();
  assert.equal(data.enabled_saffron_search, true);
  assert.equal(data.claudex_memory.search_action, "available");
  assert.equal(data.claudex_memory.generation_action, "consent_and_budget_not_established");
  await f.setServerPolicy({ generate: false, search_chats: true });
  assert.deepEqual((await f.capability()).preferences, { generate: false, searchChats: true });
  assert.equal((await f.post(settingsPath, { enabled_saffron_search: false, user_initiated: true })).status, 200);
  f.setPolicyPending();
  assert.deepEqual((await f.capability()).preferences, { generate: false, searchChats: false });
  assert.equal((await f.post(settingsPath, { enabled_saffron_search: true, user_initiated: true })).status, 501);
  assert.deepEqual(f.preferenceWrites, [{ search_chats: true }, { search_chats: false }]);
});

test("Web settings return persisted Classic and Off mode changes and keep classified mode during search", async (t) => {
  const f = await fixture(t, {
    generate: false,
    searchChats: false,
    melange: { mode: "melange", files: [{ path: "profile.md", content: "Saved profile", updated_at: "2026-01-01T00:00:00Z" }] },
  });
  const search = await f.post(settingsPath, { enabled_saffron_search: true, user_initiated: true });
  assert.equal(search.status, 200);
  assert.equal((await search.json()).memory_mode, "melange");
  assert.equal(f.melange().revision, 0);
  assert.equal(f.melange().state?.files[0].content, "Saved profile");
  assert.deepEqual(f.prefs(), { generate: false, search_chats: true });
  const classic = await f.post(settingsPath, { enabled_melange: false, enabled_saffron: true, user_initiated: true });
  assert.equal(classic.status, 200);
  const classicData = await classic.json();
  assert.equal(classicData.memory_mode, "classic");
  assert.deepEqual(classicData.claudex_memory.preferences, { generate: true, searchChats: true });
  const off = await f.post(settingsPath, { enabled_melange: false, enabled_saffron: false, user_initiated: true });
  assert.equal(off.status, 200);
  const offData = await off.json();
  assert.equal(offData.memory_mode, "off");
  assert.deepEqual(offData.claudex_memory.preferences, { generate: false, searchChats: true });
  assert.equal(f.melange().state?.mode, "off");
  assert.equal(f.melange().state?.files[0].content, "Saved profile");
  assert.deepEqual(f.preferenceWrites, [{ search_chats: true }]);
  assert.equal((await (await f.fetchOfficial(settingsPath)).json()).memory_mode, "off");
});

test("an acknowledged reset with failed readback reports cleared data without a stale controls version", async (t) => {
  const f = await fixture(t);
  f.rejectReadback();
  const answer = await f.post(resetPath, { project_uuid: projectId });
  assert.equal(answer.status, 503);
  assert.match((await answer.json()).error.message, /Memory was cleared/);
  assert.equal(f.docs.has(projectScope), false);
  assert.equal(f.docs.has(otherScope), true);
  const cache = readMemoryCache(f.root);
  assert.ok(cache);
  assert.equal(cache.docs.some(doc => doc.scope === projectScope), false);
  assert.equal(cache.controlsVersions?.[projectScope], undefined);
  assert.equal(cache.emptyControlsVersion, undefined);
});
