import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

test("OAuth callback announces success only after the runner confirms discovery", async (t) => {
  const file = path.resolve(`.runtime/connector-callback-${process.pid}.mjs`);
  await build({ entryPoints: [path.resolve("src-web/official/OfficialWebSurface.tsx")], outfile: file, bundle: true, platform: "node", format: "esm", external: ["react"], loader: { ".css": "empty", ".svg": "text" } });
  t.after(() => fs.rmSync(file, { force: true }));
  const { OfficialWebSurface } = await import(pathToFileURL(file).href);
  const organization = "11111111-1111-4111-8111-111111111111";
  const server = "22222222-2222-4222-8222-222222222222";
  const dom = new JSDOM('<div id="root"></div>', { url: "https://fixture.invalid/mcp/oauth/callback?state=state&code=code" });
  const keys = ["window", "document", "history", "location", "localStorage", "BroadcastChannel", "addEventListener", "removeEventListener"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, (globalThis as any)[key]]));
  const messages: unknown[] = [];
  let closeCount = 0;
  class Channel {
    constructor(name: string) { assert.equal(name, "mcp-auth-channel"); }
    postMessage(value: unknown) { messages.push(value); }
    close() {}
  }
  dom.window.close = () => { closeCount++; };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, history: dom.window.history, location: dom.window.location, localStorage: dom.window.localStorage, BroadcastChannel: Channel, addEventListener: dom.window.addEventListener.bind(dom.window), removeEventListener: dom.window.removeEventListener.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
  const saveAttempt = () => localStorage.setItem("claudex:mcp-auth:state", JSON.stringify({
    accountId: "owner", organizationId: organization, serverId: server,
    returnRoute: "/", expires: Date.now() + 60000,
  }));
  saveAttempt();
  let finish!: (value: unknown) => void;
  const bridge: any = {
    auth: { current: { account: { id: "owner" } }, activationIdentity: {}, onChange: () => () => {} },
    officialUiRead: async () => ({ status: 200, contentType: "application/json", body: new TextEncoder().encode(JSON.stringify({ version: 1, accountId: "owner", activationLease: "11111111-1111-4111-8111-111111111111", mode: "engine-chat", textChat: { state: "ready", reason: "ready" } })) }),
    officialUiAction: (request: any) => {
      assert.equal(request.path, `/api/organizations/${organization}/mcp/complete-auth/${server}`);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body)), { state: "state", code: "code" });
      return new Promise(resolve => { finish = resolve; });
    },
    officialUiEvents: () => () => {},
  };
  let root = createRoot(document.getElementById("root")!);
  t.after(async () => { await act(async () => root.unmount()); Object.assign(globalThis, previous); });
  await act(async () => root.render(React.createElement(OfficialWebSurface, { bridge, accountId: "owner", chatActionMode: "engine-chat" })));
  assert.deepEqual(messages, []);
  assert.equal(document.querySelector("iframe"), null);
  assert.equal(location.search, "");
  await act(async () => { finish({ status: 200, contentType: "application/json", body: new Uint8Array() }); });
  assert.deepEqual(messages, [{ type: "mcp-auth-complete", step: "success", serverId: server }]);
  assert.equal(closeCount, 1);
  assert.ok(document.querySelector("iframe"));
  await act(async () => root.unmount());
  history.replaceState(null, "", "/mcp/oauth/callback?state=state&code=code");
  saveAttempt();
  messages.length = 0;
  root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(React.createElement(OfficialWebSurface, { bridge, accountId: "owner", chatActionMode: "engine-chat" })));
  await act(async () => { finish({ status: 503, contentType: "application/json", body: new Uint8Array() }); });
  assert.deepEqual(messages, [{ type: "mcp-auth-complete", step: "error", serverId: server }]);
  assert.equal(closeCount, 2);
});
