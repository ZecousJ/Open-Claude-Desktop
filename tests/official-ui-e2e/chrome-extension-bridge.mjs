import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChromeExtensionBridge } from "../../electron/browser/chrome-extension-bridge.ts";

assert.equal(process.platform, "darwin");
const root = fileURLToPath(new URL("../../", import.meta.url));
const extension = path.join(root, "chrome-extension");
const chrome =
  process.env.CLAUDEX_CHROME_TEST_BINARY ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
assert.ok(
  fs.existsSync(chrome),
  "Install Chrome or set CLAUDEX_CHROME_TEST_BINARY",
);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-chrome-test-"));
const profile = path.join(temp, "profile");
const policy = path.join(temp, "loopback-only.sb");
const host = path.join(temp, "claudex-chrome-native-host");
const bridge = new ChromeExtensionBridge();
const fixture = http.createServer((req, res) => {
  const label = req.url === "/shared" ? "SHARED PAGE" : "PRIVATE SIBLING";
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><title>${label}</title><p>${label}</p>
    <button onclick="this.innerText='CLICKED'">Click me</button>
    <label>Test field<input></label>`);
});
let child;
let childExit;

try {
  execFileSync(
    "go",
    [
      "build",
      "-trimpath",
      "-o",
      host,
      path.join(root, "tools/chrome-native-host/main.go"),
    ],
    { stdio: "inherit" },
  );
  fs.writeFileSync(
    policy,
    [
      "(version 1)",
      "(allow default)",
      '(deny process-exec (literal "/usr/bin/open"))',
      "(deny network-outbound)",
      '(allow network-outbound (remote ip "localhost:*"))',
    ].join("\n"),
  );
  child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-f",
      policy,
      chrome,
      "--headless=new",
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-gpu",
      "--use-mock-keychain",
      "--no-sandbox",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  childExit = once(child, "exit");
  const pending = new Map();
  let id = 0;
  let buffer = "";
  child.stdio[3].on("error", () => {});
  child.stdio[4].setEncoding("utf8").on("data", (data) => {
    buffer += data;
    while (buffer.includes("\0")) {
      const separator = buffer.indexOf("\0");
      const message = JSON.parse(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 1);
      pending.get(message.id)?.(message);
    }
  });
  function send(method, params = {}, sessionId) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(Error(method + " timed out"));
      }, 6000);
      pending.set(requestId, (message) => {
        clearTimeout(timer);
        pending.delete(requestId);
        if (message.error) reject(Error(method + ": " + message.error.message));
        else resolve(message.result);
      });
      child.stdio[3].write(
        JSON.stringify({ id: requestId, method, params, sessionId }) + "\0",
      );
    });
  }
  async function open(url) {
    const { targetId } = await send("Target.createTarget", { url });
    const { sessionId } = await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return { targetId, sessionId };
  }
  async function evaluate(page, expression) {
    const answer = await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      page.sessionId,
    );
    assert.equal(answer.exceptionDetails, undefined);
    return answer.result.value;
  }
  async function wait(condition) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const result = await condition();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error("Timed out waiting for Chrome");
  }
  await send("Browser.getVersion");
  const configuration = JSON.parse(
    fs.readFileSync(path.join(extension, "manifest.json"), "utf8"),
  );
  const extensionId = createHash("sha256")
    .update(Buffer.from(configuration.key, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/./g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
  const loaded = await send("Extensions.loadUnpacked", { path: extension });
  assert.equal(loaded.id, extensionId);
  const manifests = path.join(profile, "NativeMessagingHosts");
  fs.mkdirSync(manifests, { recursive: true });
  fs.writeFileSync(
    path.join(manifests, "cn.zecous.claudex.json"),
    JSON.stringify({
      name: "cn.zecous.claudex",
      description: "Claudex Chrome integration test",
      path: host,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    }),
  );
  const endpoint = await bridge.start();
  const descriptor = path.join(temp, "chrome-bridge.json");
  fs.writeFileSync(
    descriptor,
    JSON.stringify({
      ...endpoint,
      key: Buffer.alloc(32).toString("base64url"),
    }),
    { mode: 0o600 },
  );
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const port = fixture.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const sharedUrl = origin + "/shared";
  const sibling = await open(origin + "/sibling");
  const shared = await open(sharedUrl);
  await wait(() => evaluate(shared, "document.title === 'SHARED PAGE'"));
  assert.equal(bridge.page(), undefined);
  const { targetInfos } = await send("Target.getTargets", {
    filter: [{ type: "tab", exclude: false }, { exclude: true }],
  });
  const sharedTab = targetInfos.find((target) => target.url === sharedUrl);
  assert.ok(sharedTab);
  await send("Target.activateTarget", { targetId: shared.targetId });
  await wait(() => evaluate(shared, "!document.hidden"));
  // The browser toolbar refreshes its action after the document becomes visible.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const share = () =>
    send("Extensions.triggerAction", {
      id: extensionId,
      targetId: sharedTab.targetId,
    });
  await share();
  const worker = await wait(async () => {
    const { targetInfos } = await send("Target.getTargets");
    return targetInfos.find(
      (target) =>
        target.type === "service_worker" &&
        target.url.startsWith(`chrome-extension://${extensionId}/`),
    );
  });
  const workerSession = await send("Target.attachToTarget", {
    targetId: worker.targetId,
    flatten: true,
  });
  await wait(() =>
    evaluate(
      workerSession,
      `(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab && (await chrome.action.getBadgeText({ tabId: tab.id })) === "!";
  })()`,
    ),
  );
  assert.equal(bridge.page(), undefined);
  fs.writeFileSync(descriptor, JSON.stringify(endpoint), { mode: 0o600 });
  await share();
  const page = await wait(() => bridge.page());
  assert.equal(page.origin, origin);
  const request = (operation) =>
    bridge.request(page.id, operation, AbortSignal.timeout(4000));

  const inspected = await request({ operation: "inspect" });
  assert.equal(inspected.title, "SHARED PAGE");
  assert.match(inspected.text, /SHARED PAGE/);
  assert.doesNotMatch(inspected.text, /PRIVATE SIBLING/);
  const button = inspected.controls.find(({ label }) => label === "Click me");
  const field = inspected.controls.find(({ type }) => type === "input");
  await request({
    operation: "fill",
    revision: inspected.revision,
    index: field.index,
    text: "only this tab",
  });
  await request({
    operation: "click",
    revision: inspected.revision,
    index: button.index,
  });
  assert.equal(
    await evaluate(shared, "document.querySelector('button').textContent"),
    "CLICKED",
  );
  assert.equal(
    await evaluate(shared, "document.querySelector('input').value"),
    "only this tab",
  );
  assert.equal(
    await evaluate(sibling, "document.querySelector('button').textContent"),
    "Click me",
  );
  assert.equal(
    await evaluate(sibling, "document.querySelector('input').value"),
    "",
  );

  await send(
    "Page.navigate",
    { url: `http://localhost:${port}/other-origin` },
    shared.sessionId,
  );
  await wait(() => bridge.page() === undefined);
  assert.throws(
    () => request({ operation: "inspect" }),
    /Share the Chrome tab/,
  );
  console.log(
    "Isolated Chrome rejected stale pairing, shared one document, accepted native read and form actions, and revoked access on navigation.",
  );
} finally {
  bridge.close();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  if (child && child.exitCode === null && child.signalCode === null)
    child.kill();
  await childExit;
  fs.rmSync(temp, { recursive: true, force: true });
}
