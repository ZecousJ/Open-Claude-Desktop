import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { authorizeWithGoogle, cancelGoogleAuthorization } from "../electron/account/google-sign-in";
import { accountBrowserStorage, savedAccountUiPorts } from "../electron/official-ui/account-browser-storage";
import { reserveLoopbackPort } from "../electron/loopback-ports";
import { startOfficialUiServer } from "../electron/official-ui/server";
import { BrowserMcpServer } from "../electron/browser/mcp-server";
import { ArtifactShares } from "../electron/artifacts/artifact-shares";

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-startup-ports-"));
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile);
  fs.mkdirSync(path.join(root, "ui"));
  fs.writeFileSync(path.join(root, "ui/index.html"), "<!doctype html><p>Stored account UI</p>");
  const available = http.createServer();
  await new Promise<void>(resolve => available.listen(0, "127.0.0.1", resolve));
  const port = (available.address() as { port: number }).port;
  await new Promise<void>(resolve => available.close(() => resolve()));
  const storage = accountBrowserStorage("fixture", profile, root);
  fs.mkdirSync(path.dirname(storage.portFile), { recursive: true });
  fs.writeFileSync(storage.portFile, `${port}\n`);
  for (const saved of savedAccountUiPorts(root)) reserveLoopbackPort(saved);
  return { root, profile, port, storage };
}

test("startup Browser MCP leaves the stored account origin available when the OS selects it", async t => {
  const { root, profile, port, storage } = await fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = http.Server.prototype.listen;
  let offeredReserved = false;
  const listen = t.mock.method(http.Server.prototype, "listen", function(this: http.Server, ...args: any[]) {
    if (args[0] === 0 && !offeredReserved) { args[0] = port; offeredReserved = true; }
    return Reflect.apply(original, this, args);
  });
  const browser = new BrowserMcpServer({ token: "fixture-token-for-local-browser-tools", handlers: {} as never });
  t.after(() => browser.close());
  await browser.start();
  listen.mock.restore();
  assert.equal(offeredReserved, true);
  assert.notEqual(browser.port, port);
  const ui = await startOfficialUiServer({ root, portFile: storage.portFile, requireStablePort: true, api: () => false });
  t.after(() => ui.close());
  assert.equal(ui.origin, `http://localhost:${port}`);
  const response = await fetch(ui.origin, { headers: { Cookie: `claudex_official_ui=${ui.token}` } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Stored account UI/);
  assert.equal(fs.readFileSync(storage.portFile, "utf8"), `${port}\n`);
  assert.deepEqual(accountBrowserStorage("fixture", profile, root), storage);
});

test("Google sign-in leaves the saved account origin available while its callback is listening", async t => {
  const { root, port, storage } = await fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(cancelGoogleAuthorization);
  const original = http.Server.prototype.listen;
  let offeredReserved = false;
  const listen = t.mock.method(http.Server.prototype, "listen", function(this: http.Server, ...args: unknown[]) {
    if (args[0] === 0 && !offeredReserved) {
      args[0] = port;
      offeredReserved = true;
    }
    return Reflect.apply(original, this, args);
  });
  let onOpen!: (url: URL) => void;
  const opened = new Promise<URL>(resolve => { onOpen = resolve; });
  const authorization = authorizeWithGoogle("fixture.apps.googleusercontent.com", async url => {
    onOpen(new URL(url));
  });
  const google = await Promise.race([
    opened,
    authorization.then(() => assert.fail("Authorization completed before opening the browser.")),
  ]);
  listen.mock.restore();
  assert.equal(offeredReserved, true);

  const ui = await startOfficialUiServer({ root, portFile: storage.portFile, requireStablePort: true, api: () => false });
  t.after(() => ui.close());
  assert.equal(ui.origin, `http://localhost:${port}`);
  const response = await fetch(ui.origin, { headers: { Cookie: `claudex_official_ui=${ui.token}` } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Stored account UI/);
  const redirect = new URL(google.searchParams.get("redirect_uri")!);
  redirect.searchParams.set("code", "fixture-code");
  redirect.searchParams.set("state", google.searchParams.get("state")!);
  const callback = await fetch(redirect);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /signed in/i);
  assert.equal((await authorization).code, "fixture-code");
});

test("the original Cowork home alias carries its mode through cold navigation", async (t) => {
  const {root} = await fixture();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, "main-window"));
  fs.writeFileSync(path.join(root, "main-window/view.html"), '<html data-desktop-boot-placeholder>');
  const ui = await startOfficialUiServer({root, desktopStartup: true, api: () => false});
  t.after(() => ui.close());
  const headers = {Cookie: `claudex_official_ui=${ui.token}`};
  const redirect = await fetch(ui.origin + "/task/new?q=setup", {headers, redirect: "manual"});
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("location"), "/task/new?q=setup&mode=cowork");
  const explicit = await fetch(ui.origin + "/task/new?mode=cowork", {headers, redirect: "manual"});
  assert.equal(explicit.status, 200);
  const home = await fetch(ui.origin + "/new", {headers, redirect: "manual"});
  assert.equal(home.status, 200);
  for (const route of [home, explicit])
    assert.match(await route.text(), /data-desktop-boot-placeholder/);
});

test("an earlier artifact share listener relocates from a saved UI origin", async t => {
  const { root, profile, port, storage } = await fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharePort = path.join(profile, "artifact-shares-port");
  fs.writeFileSync(sharePort, String(port));
  const shares = new ArtifactShares(profile);
  t.after(() => shares.stop());
  await shares.start(port);
  assert.notEqual(Number(fs.readFileSync(sharePort, "utf8")), port);
  const ui = await startOfficialUiServer({ root, portFile: storage.portFile, requireStablePort: true, api: () => false });
  t.after(() => ui.close());
  assert.equal(ui.origin, `http://localhost:${port}`);
  assert.equal(fs.readFileSync(storage.portFile, "utf8"), `${port}\n`);
});


test("saved sharing links remain on their port when a different account reserves it", async t => {
  const { root, profile, port } = await fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharePort = path.join(profile, "artifact-shares-port");
  fs.writeFileSync(sharePort, String(port));
  const shares = new ArtifactShares(profile);
  t.after(() => shares.stop());
  await shares.start();
  assert.equal(Number(fs.readFileSync(sharePort, "utf8")), port);
});
