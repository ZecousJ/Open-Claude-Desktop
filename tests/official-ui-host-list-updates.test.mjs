import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { EventEmitter } from "node:events";
import { brandedModule } from "../scripts/official-web-assets.mjs";
import { deriveOfficialUiUserContent } from "../scripts/official-ui-host-usercontent.mjs";
import { deriveOfficialUiHostListUpdatesModule, hostListUpdatesTarget, listUpdatesEffect } from "../scripts/official-ui-host-list-updates.mjs";

const assets = path.resolve(process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted", "claude-frontend-4.4212.0/src/cloud/assets/v1");
function originalClient() {
  const code = fs.readFileSync(path.join(assets, "vendor-query-CdfkcLg6.js"), "utf8")
    .replace(/^import\s*\{[\s\S]*?from "\.\/vendor-frame-iz8L1jC9.js";/, "")
    .replace(/export \{[\s\S]*$/, "");
  const scope = vm.createContext({ console, setTimeout, clearTimeout, queueMicrotask, AbortController,
    i: () => ({ Provider: {} }), e() {}, t() {}, n() {}, r() {}, a() {}, o() {}, s() {}, c() {} });
  return vm.runInContext(`${code}\n${listUpdatesEffect}\n({ Client: Ue, Observer: V, watch: claudexObserveConversationLists })`, scope);
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail("Original query did not reach the expected state");
}
const eventName = "claudex:conversation-lists-invalidated";
function signal(target, revision) { target.__claudexConversationListsRevision = revision; target.dispatchEvent(new Event(eventName)); }

test("the pinned shell retains its original behavior and mounts the list notification effect", () => {
  const raw = fs.readFileSync(path.join(assets, hostListUpdatesTarget), "utf8");
  const input = brandedModule(deriveOfficialUiUserContent(hostListUpdatesTarget, raw));
  const output = deriveOfficialUiHostListUpdatesModule(hostListUpdatesTarget, input);
  assert.ok(output.includes("k_(() => claudexObserveConversationLists(e, v), [e, v]);"));
  assert.throws(() => deriveOfficialUiHostListUpdatesModule(hostListUpdatesTarget, input + " "), /input mismatch/);
  assert.equal(deriveOfficialUiHostListUpdatesModule("other.js", "original"), "original");
});

test("a cloud resync replaces a pending initial list using the actual original QueryClient", async t => {
  const { Client, Observer, watch } = originalClient();
  const client = new Client({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  t.after(() => client.clear());
  const stale = deferred(); let reads = 0;
  const key = ["chat_conversation_list", { orgUuid: "account-a" }, "infinite", { limit: 30 }];
  const observer = new Observer(client, { queryKey: key, queryFn: () => ++reads === 1 ? stale.promise : Promise.resolve(["cloud-history"]) });
  const off = observer.subscribe(() => {}); t.after(off);
  await until(() => reads === 1);
  const unrelated = ["chat_conversation_list", { orgUuid: "account-b" }];
  client.setQueryData(unrelated, ["other-account"]);
  const target = new EventTarget(); target.__claudexConversationListsRevision = 0;
  const stop = watch(client, "account-a", target); t.after(stop);
  signal(target, 1);
  await until(() => client.getQueryData(key)?.[0] === "cloud-history");
  stale.resolve(["stale-local-only"]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reads, 2);
  assert.deepEqual(Array.from(client.getQueryData(key)), ["cloud-history"]);
  assert.deepEqual(client.getQueryData(unrelated), ["other-account"]);
  assert.equal(client.getQueryState(unrelated).isInvalidated, false);
});

test("early and overlapping resyncs catch up once, and disposal does not refresh a retired organization", async t => {
  const { Client, Observer, watch } = originalClient();
  const client = new Client({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  t.after(() => client.clear());
  const key = ["served-recents-search", "account-a", "active"];
  client.setQueryData(key, ["local"]);
  const slow = deferred(); let reads = 0;
  const observer = new Observer(client, { queryKey: key, staleTime: Infinity, queryFn: () => ++reads === 1 ? slow.promise : Promise.resolve(["latest"]) });
  const off = observer.subscribe(() => {}); t.after(off);
  const target = new EventTarget(); target.__claudexConversationListsRevision = 1;
  const stop = watch(client, "account-a", target);
  await until(() => reads === 1);
  signal(target, 2); slow.resolve(["intermediate"]);
  await until(() => client.getQueryData(key)?.[0] === "latest");
  assert.equal(reads, 2);
  stop(); signal(target, 3);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reads, 2);
  assert.equal(watch(client, "account-a", new EventTarget()), undefined);
});

test("the preload retains notifications arriving before the original shell subscribes", () => {
  const file = fs.readFileSync(new URL("../electron/official-ui/page-shim.cjs", import.meta.url), "utf8");
  const source = file.slice(file.indexOf("// Keep a notification received during the initial query"));
  const window = new EventTarget(), ipcRenderer = new EventEmitter();
  const contextBridge = { executeInMainWorld: ({ func, args = [] }) => func(...args) };
  vm.runInNewContext(source, { process: { isMainFrame: true }, window, Event, ipcRenderer, contextBridge });
  ipcRenderer.emit(eventName);
  assert.equal(window.__claudexConversationListsRevision, 1);
  let calls = 0; window.addEventListener(eventName, () => { calls++; });
  ipcRenderer.emit(eventName);
  assert.equal(calls, 1);
  assert.equal(window.__claudexConversationListsRevision, 2);
});


test("cloud recovery refreshes project metadata and a mounted missing-project query", async t => {
  const { Client, Observer, watch } = originalClient();
  const client = new Client({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  t.after(() => client.clear());
  const keys = [
    ["project_list", { orgUuid: "account-a", archived: false }],
    ["project_list_v2", { orgUuid: "account-a" }, { limit: 30 }],
    ["projects_count", { orgUuid: "account-a", accountUuid: "user-a" }],
    ["project", { orgUuid: "account-a", projectUuid: "project-a" }],
    ["project_list_conversations", { orgUuid: "account-a", projectUuid: "project-a" }, { limit: 30 }],
  ];
  let available = false;
  for (const key of keys) {
    const observer = new Observer(client, { queryKey: key, queryFn: async () => {
      if (!available) throw Error("Project not found in the initial local snapshot");
      return { recovered: true };
    } });
    t.after(observer.subscribe(() => {}));
  }
  await until(() => keys.every(key => client.getQueryState(key)?.status === "error"));
  const unrelated = ["project", { orgUuid: "account-b", projectUuid: "project-b" }];
  client.setQueryData(unrelated, { unchanged: true });
  available = true;
  const target = new EventTarget(); target.__claudexConversationListsRevision = 0;
  t.after(watch(client, "account-a", target));
  signal(target, 1);
  await until(() => keys.every(key => client.getQueryData(key)?.recovered));
  assert.equal(client.getQueryState(unrelated).isInvalidated, false);
  assert.deepEqual(client.getQueryData(unrelated), { unchanged: true });
});
