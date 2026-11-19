import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { LocalMemoryStore } from "../../electron/memory/local-store";
import { MemoryService } from "../../electron/memory/service";
import { organizationUuid } from "../../electron/official-ui/api/context";
import type { MemoryScopeRef } from "../../shared/memory-api";
import { openPolicy } from "../../shared/client-policy";
import { officialMemoryCapabilitiesPath, type OfficialMemoryCapability } from "../../shared/official-memory-capability";
import type { OfficialUiReadRequest, OfficialUiReadResponse } from "../../shared/official-ui-web";
import { WebTransport } from "../../shared/web-client/transport";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";
import type { CallFrame } from "../../runner/src/dispatcher";
import type { WebAppContext } from "../../runner/src/web-app-context";
import type { RunnerFrame } from "../../shared/web-runner-frames";
import { negotiatedMemoryAction } from "../../src-web/official/negotiated-memory-action";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { useElectronShim } from "./runner-core-support.test.ts";

useElectronShim();
const { Dispatcher } = await import("../../runner/src/dispatcher");

const accountId = "owner";
const projectId = "11111111-1111-4111-8111-111111111111";
const endpoint = `/api/organizations/${organizationUuid(accountId)}/memory/synthesize`;
const user = { id: 7, accessToken: "fixture-token" };

function synthesisRequest(body: unknown = {}, route = endpoint): OfficialUiReadRequest {
  return { method: "POST", path: route, contentType: "application/json", body: Buffer.from(JSON.stringify(body)) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f054-web-memory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new LocalMemoryStore(root);
  const service = new MemoryService({ store, policy: () => openPolicy, changed() {} });
  t.after(() => service.close());
  await service.setPrefs({ generate: true });
  const projects = [{ id: projectId }];
  const settings = { providers: [{ id: "fixture" }], activeProviderId: "fixture" };
  const scopes: unknown[] = [];
  let identity = 1;
  let sequence = 0;
  const regenerate = (scope: MemoryScopeRef) => {
    scopes.push(scope);
    return { content: "Regenerated memory", updatedAt: 1, edits: [] };
  };
  const handlers = new Map<string, (...args: never[]) => unknown>([
    ["snapshot", () => ({ projects })],
    ["synthesizeMemory", regenerate],
  ]);
  const ctx = {
    userId: user.id, activeAccount: { id: accountId },
    officialSessionIdentity: () => identity, setAccessToken() {}, onEvent: () => () => {},
    services: { memory: { service } }, store: { root, settings, projects },
    appVersion: "fixture", log() {}, engineRunning: () => false,
  } as unknown as WebAppContext;
  const responses = new Map<string, RunnerFrame>();
  const dispatcher = new Dispatcher({
    officialUiRoot: path.resolve("build/official-ui"), officialUiActions: true,
    runtime: {} as ConstructorParameters<typeof Dispatcher>[0]["runtime"],
    link: {
      send(frame) {
        if (frame.t === "result") responses.set(frame.id, frame);
        return true;
      },
      request: async () => { throw Error("Unexpected relay request"); },
    },
    openUrl() {}, publish() {}, log() {},
  });
  dispatcher.contexts.set(user.id, { ...ctx, handlers } as unknown as WebAppContext);
  const frame = (method: string, args: unknown[]): CallFrame => ({
    t: "call", id: `fixture-${++sequence}`, user, method,
    args: encodeWireValue(args) as unknown[], deadlineMs: 120_000,
  });
  const run = (method: string, request: OfficialUiReadRequest) =>
    dispatcher.run(frame(method, [request])) as Promise<OfficialUiReadResponse>;
  const capability = async () => {
    const answer = await run("officialUiRead", { method: "GET", path: officialMemoryCapabilitiesPath });
    assert.equal(answer.status, 200);
    return JSON.parse(Buffer.from(answer.body).toString()) as OfficialMemoryCapability;
  };
  const relayFetch: typeof fetch = async (url, init) => {
    const method = new URL(String(url), "https://app.fixture.invalid").pathname.split("/").at(-1)!;
    const request = JSON.parse(String(init?.body));
    const call = frame(method, decodeWireValue(request.args) as unknown[]);
    const signal = init?.signal;
    const abort = () => dispatcher.cancel(call.id);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      await dispatcher.call(call);
      signal?.throwIfAborted();
      assert.ok(responses.has(call.id));
      return Response.json(responses.get(call.id));
    } finally {
      signal?.removeEventListener("abort", abort);
      responses.delete(call.id);
    }
  };
  return { dispatcher, frame, run, capability, service, handlers, settings, scopes, regenerate, responses,
    rotate() { identity++; }, relayFetch };
}

test("official synthesis requires a ready runtime and current lease, validates scope, and dispatches only the requested scope", async t => {
  const f = await fixture(t);
  assert.equal((await f.capability()).synthesis, undefined);
  f.service.setRunState(() => ({ synthesizing: false }));
  const capability = await f.capability();
  assert.equal(capability.synthesis, "ready");
  assert.equal(capability.generation, "unavailable");
  const action = (request: OfficialUiReadRequest, lease = capability.activationLease) =>
    f.run("officialUiAction", { ...request, capabilityLease: lease });
  assert.equal((await action(synthesisRequest(), "stale")).status, 409);
  assert.equal((await action(synthesisRequest({ project_uuid: null }))).status, 400);
  assert.equal((await action(synthesisRequest({ project_uuid: "22222222-2222-4222-8222-222222222222" }))).status, 404);
  assert.equal((await action(synthesisRequest({}, endpoint.replace(organizationUuid(accountId), organizationUuid("foreign"))))).status, 404);
  await assert.rejects(action(synthesisRequest({}, endpoint + `?project_uuid=${projectId}`)));
  f.handlers.delete("synthesizeMemory");
  assert.equal((await f.capability()).synthesis, undefined);
  assert.equal((await action(synthesisRequest())).status, 501);
  f.handlers.set("synthesizeMemory", f.regenerate);
  f.settings.activeProviderId = "missing";
  assert.equal((await f.capability()).synthesis, undefined);
  f.settings.activeProviderId = "fixture";
  await f.service.setPrefs({ generate: false });
  assert.equal((await action(synthesisRequest())).status, 501);
  assert.deepEqual(f.scopes, []);
  await f.service.setPrefs({ generate: true });
  for (const body of [{}, { project_uuid: projectId }]) {
    const result = await action(synthesisRequest(body));
    assert.equal(result.status, 200, Buffer.from(result.body).toString());
    assert.equal(JSON.parse(Buffer.from(result.body).toString()).memory, "Regenerated memory");
  }
  assert.deepEqual(f.scopes, [{ kind: "global" }, { kind: "project", projectId }]);
  f.rotate();
  assert.equal((await action(synthesisRequest())).status, 409);
});

test("abort crosses the browser HTTP call and reaches the registered synthesis handler", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  f.service.setRunState(() => ({ synthesizing: false }));
  const entered = deferred();
  const stopped = deferred();
  f.handlers.set("synthesizeMemory", async (scope: MemoryScopeRef, signal: AbortSignal) => {
    assert.deepEqual(scope, { kind: "global" });
    assert.ok(signal instanceof AbortSignal);
    entered.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    stopped.resolve();
    signal.throwIfAborted();
  });
  const timers = {
    setTimeout, setInterval,
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
  } satisfies import("../../shared/web-client/env").Timers;
  const transport = new WebTransport({ fetch: f.relayFetch, timers }, {
    activationIdentity: {}, accessToken: async () => user.accessToken, refresh: async () => null, expire() {},
  }, "tab-00000001");
  const read = (request: OfficialUiReadRequest) => f.run("officialUiRead", request);
  const action = negotiatedMemoryAction({
    enabled: false, accountId: String(user.id), current: () => true, read,
    action: async (request, transfer) => await transport.call("officialUiAction",
      JSON.stringify({ args: encodeWireValue([request]) }), undefined, undefined, transfer?.signal) as OfficialUiReadResponse,
  });
  const fetchOfficial = createOfficialReadFetch("https://app.fixture.invalid", read, async () => {
    throw Error("Unexpected external fetch");
  }, undefined, action);
  const abort = new AbortController();
  const result = fetchOfficial(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: abort.signal });
  await entered.promise;
  abort.abort();
  await assert.rejects(result, { name: "AbortError" });
  await stopped.promise;
});

test("relay disconnect aborts direct synthesis without exposing a caller-supplied signal", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const entered = deferred();
  f.handlers.set("synthesizeMemory", async (scope: MemoryScopeRef, signal: AbortSignal) => {
    assert.deepEqual(scope, { kind: "project", projectId });
    assert.ok(signal instanceof AbortSignal);
    entered.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted();
  });
  const result = f.dispatcher.call(f.frame("synthesizeMemory", [{ kind: "project", projectId }, { aborted: false }]));
  await entered.promise;
  f.dispatcher.abortRelayedCalls();
  await result;
  assert.equal(f.responses.size, 0);
});
