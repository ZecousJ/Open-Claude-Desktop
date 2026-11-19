/** Real React host with inert jsdom document/bridge, no official bundle or network execution. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { officialUiCapabilitiesPath } from "../../shared/official-ui-web";
import { WebAuth } from "../../src-web/bridge/auth";
import { fakeTab } from "./web-bridge-fakes.test";
const completion = { method: "POST", path: "/api/organizations/11111111-1111-4111-8111-111111111111/chat_conversations/22222222-2222-4222-8222-222222222222/completion", body: new TextEncoder().encode('{"tools":[]}'), contentType: "application/json" };
async function fixture(t: any, enabled: boolean, deferred = false, actualAuth = false) {
  const file = path.resolve(`.runtime/official-capability-surface-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
  t.after(() => fs.rmSync(file, { force: true }));
  await build({ entryPoints: [path.resolve("src-web/official/OfficialWebSurface.tsx")], outfile: file, bundle: true, platform: "node", format: "esm", external: ["react"], loader: { ".css": "empty", ".svg": "text" } });
  const { OfficialWebSurface } = await import(pathToFileURL(file).href);
  const dom = new JSDOM('<div id="root"></div>', { url: "https://fixture.invalid/new" });
  const previous = { window: globalThis.window, document: globalThis.document, history: globalThis.history, location: globalThis.location };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, history: dom.window.history, location: dom.window.location, IS_REACT_ACT_ENVIRONMENT: true });
  let reads = 0, actions = 0, release!: (v: any) => void;
  let readiness = { state: "unavailable", reason: "executor_unavailable" };
  const listeners = new Set<(v: any) => void>();
  const response = () => ({ status: 200, contentType: "application/json", body: new TextEncoder().encode(JSON.stringify({ version: 1, accountId: "owner", activationLease: "11111111-1111-4111-8111-111111111111", mode: "strict-text", textChat: readiness })) });
  const bridge: any = { auth: { activationIdentity: {}, current: { account: { id: "owner" } }, onChange: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); } },
    officialUiRead: (request: any) => { reads++; assert.equal(request.path, officialUiCapabilitiesPath); return deferred ? new Promise(r => release = r) : Promise.resolve(response()); },
    officialUiAction: async () => { actions++; return { status: 200, contentType: "application/json", body: new Uint8Array() }; }, officialUiEvents: () => () => {} };
  let auth: WebAuth | undefined;
  if (actualAuth) {
    auth = new WebAuth(fakeTab().env, "inert-surface-tab", () => {});
    await auth.adopt({ access_token: "inert-original", expires_in: 3600, account: { id: "owner", email: "fixture@example.invalid", name: "Fixture" } });
    bridge.auth = auth;
    t.after(() => auth!.dispose());
  }
  const root = createRoot(document.getElementById("root")!);
  t.after(async () => { try { await act(async () => root.unmount()); } finally { Object.assign(globalThis, previous); dom.window.close(); } });
  await act(async () => root.render(React.createElement(OfficialWebSurface, { bridge, accountId: "owner", ...(enabled ? { chatActionMode: "strict-text" } : {}) })));
  const iframe = document.querySelector("iframe")!;
  const binding = (window as any).__claudexOfficialFrameBindings(iframe.contentWindow, iframe.contentDocument);
  return { binding, iframe, auth, get reads() { return reads; }, get actions() { return actions; }, text: () => document.body.textContent ?? "",
    ready: () => readiness = { state: "ready", reason: "ready" }, release: () => release(response()),
    retire: () => { bridge.auth.current = undefined; for (const fn of listeners) fn(undefined); } };
}
test("default actual host remains read-only and does not negotiate or dispatch", async t => {
  const f = await fixture(t, false); assert.equal(f.reads, 0); assert.doesNotMatch(f.text(), /Experimental|unverified|read-only/);
  assert.equal((await f.binding.action(completion)).status, 501); assert.equal(f.actions, 0);
});
test("opted-in actual host omits outer result strips and still negotiates every action", async t => {
  const f = await fixture(t, true); assert.equal(f.reads, 0); assert.doesNotMatch(f.text(), /verified strict text executor is not installed/);
  let denied: any; await act(async () => { denied = await f.binding.action(completion); });
  assert.equal(denied.status, 501); assert.equal(f.actions, 0); assert.equal(f.reads, 1);
  f.ready(); await act(async () => { assert.equal((await f.binding.action(completion)).status, 200); });
  assert.equal(f.actions, 1); assert.equal(f.reads, 2); assert.doesNotMatch(f.text(), /each send still requires/);
});
test("late ready discovery cannot update or re-enable a retired account document", async t => {
  const f = await fixture(t, true, true); assert.equal(f.reads, 0);
  const pending = f.binding.action(completion); const rejected = assert.rejects(pending, {name:"AbortError"});
  await act(async () => { f.retire(); f.ready(); f.release(); });
  await rejected; assert.equal(document.querySelector("iframe"), null); assert.doesNotMatch(f.text(), /Strict text capability is available/);
  await assert.rejects(() => f.binding.action(completion), { name: "AbortError" }); assert.equal(f.actions, 0);
});

test("actual WebAuth local refresh preserves official frame and inert draft, but same-account login retires it", async t => {
  const f = await fixture(t, true, false, true);
  const auth = f.auth!; const epoch = auth.activationIdentity;
  const inertBody = f.iframe.contentDocument!.createElement("body");
  f.iframe.contentDocument!.append(inertBody);
  const draft = f.iframe.contentDocument!.createElement("textarea");
  draft.value = "Self-authored inert draft"; inertBody.append(draft);
  f.ready(); await act(async () => { assert.equal((await f.binding.action(completion)).status, 200); });
  auth.post = async () => ({ status: 200, value: { access_token: "inert-refreshed", expires_in: 3600, account: auth.current!.account } });
  await act(async () => { await auth.refreshNow(auth.current!.accessToken); });
  assert.equal(auth.activationIdentity, epoch); assert.equal(document.querySelector("iframe"), f.iframe);
  assert.equal(f.iframe.contentDocument!.querySelector("textarea")!.value, "Self-authored inert draft");
  await act(async () => { assert.equal((await f.binding.action(completion)).status, 200); });
  assert.equal(f.actions, 2);
  await act(async () => { await auth.adopt({ access_token: "inert-relogin", expires_in: 3600, account: auth.current!.account }); });
  assert.notEqual(auth.activationIdentity, epoch); assert.notEqual(document.querySelector("iframe"), f.iframe);
  assert.ok(document.querySelector("iframe")); assert.doesNotMatch(f.text(), /account session changed/i);
  await assert.rejects(() => f.binding.action(completion), { name: "AbortError" }); assert.equal(f.actions, 2);
});
test("actual WebAuth cross-tab replacement retires the old frame and mounts a fresh one", async t => {
  const f = await fixture(t, true, false, true); const auth = f.auth!;
  await act(async () => auth.fromTab({ type: "session", session: { ...auth.current!, accessToken: "inert-other-tab", expiresAt: auth.current!.expiresAt + 1 } }));
  assert.ok(document.querySelector("iframe")); assert.notEqual(document.querySelector("iframe"), f.iframe);
  assert.doesNotMatch(f.text(), /account session changed/i);
  await assert.rejects(() => f.binding.action(completion), { name: "AbortError" }); assert.equal(f.actions, 0);
});
