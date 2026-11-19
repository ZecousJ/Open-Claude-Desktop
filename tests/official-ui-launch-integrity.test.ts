import test from "node:test";
import assert from "node:assert/strict";
import { registerLaunch } from "../electron/official-ui/native/launch";
function setup() {
  const handlers = new Map<string, any>(); let active = true, identity = 1;
  const c: any = { id: "c", mode: "code", cwd: "/work" };
  const state: any = { tabs: [{ id: "tab", url: "about:blank" }], activeTabId: "tab",
    devServers: [{ name: "web", source: "launch.json", status: "failed", error: "startup failed" }] };
  let invoke: any = async (name: string) => {
    if (name === "browserState") return state;
    if (name === "devServersStart") return state.devServers[0];
    if (name === "officialDevServerLogs") throw Error("logs unreadable");
    throw Error(name);
  };
  const host: any = { ctx: { account: () => ({ id: "a" }), sessionIdentity: () => identity, isCurrent: () => active,
    localLoadConversation: async () => c, localListConversations: async () => [c], onEvent: () => () => {},
    localCall: (...args: any[]) => invoke(...args) }, on(n: string, f: any) { handlers.set(n, f); return host; },
    store: () => ({ get: () => [], set() {} }), emit() {} };
  registerLaunch(host);
  return { call: (name: string, ...args: any[]) => handlers.get("Launch." + name)(...args), c,
    retire: () => active = false, reactivate: () => identity++, source: (f: any) => invoke = f, state };
}
test("failed startup preserves source error and explicitly reports unavailable logs", async () => {
  const h = setup(); const result = await h.call("startFromConfig", "/work", "web", "local_c");
  assert.match(result.error, /startup failed/); assert.match(result.error, /logs could not be read: logs unreadable/);
});
test("preview frames resolve for owned SSH and WSL sessions and reject cloud or foreign sessions", async () => {
  const h = setup();
  h.c.environment = { kind: "ssh", hostId: "test-host" };
  assert.equal(await h.call("getPreviewLastFrame", "local_c"), null);
  h.c.environment = { kind: "wsl", distro: "Ubuntu" };
  h.state.tabs[0].restored = { jpegBase64: "frame" };
  assert.deepEqual(await h.call("getPreviewLastFrame", "local_c"),
    { configName: "Browser", jpegBase64: "frame" });
  h.c.environment = { kind: "space", spaceId: "foreign" };
  await assert.rejects(h.call("getPreviewLastFrame", "local_c"), /owned desktop/);
  delete h.c.environment; h.c.id = "another";
  await assert.rejects(h.call("getPreviewLastFrame", "local_c"), /owned desktop/);
  await assert.rejects(h.call("startBrowserPreview", "/work", "local_c"), /does not belong/);
});
test("late preview reads reject retirement and same-account reactivation", async () => {
  for (const action of ["retire", "reactivate"] as const) {
    const h = setup(); let done!: (x: any) => void;
    h.source(() => new Promise(r => done = r));
    const pending = h.call("getConfiguredServices", "/work");
    while (!done) await new Promise(r => setImmediate(r));
    h[action](); done(h.state); await assert.rejects(pending);
  }
});
