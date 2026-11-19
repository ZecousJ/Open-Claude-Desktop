import assert from "node:assert/strict";
import http from "node:http";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Client, sleep } from "./harness.mjs";
const web = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    "<title>Preview " +
      req.url +
      "</title><h1>PREVIEW_INTERACTION_" +
      req.url +
      "</h1>",
  );
});
await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + web.address().port;
let client;
try {
  client = await Client.launch();
  const page = client.page(0);
  await page.goto("/epitaxy");
  const key = async (key, modifiers = [], preview = false) => {
    if(preview)await page.waitFor('window["claude.web"].Launch.focusPreview("preview-landing")',15000);
    const q = new URLSearchParams({ key, preview: preview ? "1" : "0" });
    for (const m of modifiers) q.append("modifier", m);
    const r = await fetch(client.origin + "/__debug/key?" + q, {
      method: "POST",
      headers: { Cookie: client.cookie },
    });
    assert.equal(r.status, 204, await r.text());
  };
  const api = (name, ...args) =>
    page.eval(
      'window["claude.web"].Launch.' +
        name +
        "(" +
        args.map(JSON.stringify).join(",") +
        ")",
    );
  const untilTabs = (condition) =>
    page.waitFor(
      'window["claude.web"].Launch.getPreviewTabs("preview-landing").then(s=>' +
        condition +
        ")",
    );
  const navigate = async (route) => {
    await api("navigatePreview", "preview-landing", url + route);
    await page.waitFor(
      'window["claude.web"].Launch.previewSnapshot("preview-landing").then(s=>s.includes(' +
        JSON.stringify("PREVIEW_INTERACTION_" + route) +
        "))",
    );
  };
  const pressed = await page.waitFor(
    '(()=>{const b=document.querySelector("button[aria-label=Browser]");return b&&{pressed:b.getAttribute("aria-pressed")}})()',
  );
  if (pressed.pressed !== "true")
    await page.click("button[aria-label=Browser]");
  await page.waitFor(
    'Array.from(document.querySelectorAll("input")).some(e=>e.getAttribute("aria-label")==="Page URL")',
  );
  await navigate("/one");
  await api("setPreviewChromeFocus", "preview-landing", false);
  await key("l", ["meta"], true);
  await page.waitFor(
    'document.activeElement?.getAttribute("aria-label")==="Page URL"',
  );
  console.log("Native Cmd+L from preview focuses official address input.");
  const before = await api("getPreviewTabs", "preview-landing");
  await key("t", ["meta"]);
  await untilTabs("s.tabs.length===" + String(before.tabs.length + 1));
  const two = await api("getPreviewTabs", "preview-landing"),
    second = two.activeTabId;
  await navigate("/two");
  await key("Tab", ["control"], true);
  await untilTabs("s.activeTabId!==" + JSON.stringify(second));
  await key("Tab", ["control", "shift"], true);
  await untilTabs("s.activeTabId===" + JSON.stringify(second));
  console.log(
    "Native Cmd+T and Ctrl+Tab/Ctrl+Shift+Tab create and cycle real preview tabs.",
  );
  await api("reorderPreviewTab", "preview-landing", second, 0);
  assert.equal(
    (await api("getPreviewTabs", "preview-landing")).tabs[0].tabId,
    second,
  );
  await key("w", ["meta"], true);
  await untilTabs("!s.tabs.some(t=>t.tabId===" + JSON.stringify(second) + ")");
  await api("setPreviewChromeFocus", "preview-landing", true);
  await key("t", ["meta", "shift"]);
  await untilTabs(
    "s.tabs.some(t=>t.origin===" + JSON.stringify(url + "/two") + ")",
  );
  console.log(
    "Tab reorder, native Cmd+W close and Cmd+Shift+T reopen restore the page.",
  );
  await page.eval(
    '(()=>{window.__previewExited=false;window["claude.web"].Launch.onPreviewFocusExit(()=>window.__previewExited=true)})()',
  );
  await key("F6", [], true);
  await page.waitFor("window.__previewExited");
  console.log("Native F6 emits official focus exit.");
  const firstTab=(await api("getPreviewTabs","preview-landing")).tabs[0];
  await api("closeAllPreviewTabs", "preview-landing");
  const empty = await api("getPreviewTabs", "preview-landing");
  assert.equal(empty.tabs.length, 1);
  assert.equal(empty.tabs[0].tabId,firstTab.tabId);
  assert.equal(empty.tabs[0].origin,firstTab.origin);
  const gaps = client
    .logSince(0)
    .filter(
      (l) =>
        /Launch/.test(l) &&
        /not configured|without effect|Error occurred/.test(l),
    );
  assert.deepEqual(gaps, []);
  await navigate("/quit");
  const started = Date.now();
  const quit = await fetch(client.origin + "/__debug/quit", {
    method: "POST",
    headers: { Cookie: client.cookie },
  });
  assert.equal(quit.status, 204);
  while (
    client.child.exitCode === null &&
    client.child.signalCode === null &&
    Date.now() - started < 25000
  )
    await sleep(100);
  assert.ok(
    client.child.exitCode !== null || client.child.signalCode !== null,
    "Normal app.quit must exit without forced kill",
  );
  assert.equal(client.child.exitCode, 0);
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      quitMs: Date.now() - started,
      scope:
        "official native preview keys, address focus, new/cycle/close/reopen/reorder/all tabs, F6, graceful quit with active preview; no model sends",
    }),
  );
} catch (error) {
  console.error(error);
  if (client)
    console.error(
      JSON.stringify({
        errors: client
          .logSince(0)
          .filter((l) =>
            /Error|Quit|Launch|Unhandled|shutdown|e2e-quit/.test(l),
          )
          .slice(-35),
      }),
    );
  process.exitCode = 1;
} finally {
  if (client) {
    await client.stop();
    await rm(path.dirname(client.logFile), { recursive: true, force: true });
  }
  await new Promise((resolve) => web.close(resolve));
}
