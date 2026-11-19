import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { Client } from "./harness.mjs";
const web = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    "<title>Landing preview</title><h1>" +
      (req.url === "/second" ? "SECOND_WINDOW_PAGE" : "LANDING_BROWSER_PAGE") +
      "</h1>",
  );
});
await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + web.address().port;
const client = await Client.launch();
const page = client.page(0);
try {
  const before = await page.eval(
    `window['claude.web'].LocalSessions.getSessionList().then(r=>r.sessions.map(s=>s.sessionId).sort())`,
  );
  await page.goto("/epitaxy");
  const pressed = await page.waitFor(
    `(()=>{const b=document.querySelector('button[aria-label="Browser"]');return b&&{pressed:b.getAttribute('aria-pressed')}})()`,
  );
  if (pressed.pressed !== "true")
    await page.click('button[aria-label="Browser"]');
  await page.waitFor(
    `!!document.querySelector('input[aria-label="Page URL"]')`,
    20000,
  );
  await page.eval(
    `(()=>{const e=document.querySelector('input[aria-label="Page URL"]');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(url)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await page.eval(
    `document.querySelector('input[aria-label="Page URL"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}))`,
  );
  await page.waitFor(
    `window['claude.web'].Launch.previewSnapshot('preview-landing').then(s=>s.includes('LANDING_BROWSER_PAGE'))`,
    20000,
  );
  const first = await page.eval(
    `window['claude.web'].Launch.getPreviewTabs('preview-landing')`,
  );
  assert.ok(first.tabs.some((t) => t.origin === url + "/"));
  const other = await client.openPage();
  await other.goto("/epitaxy");
  await other.eval(
    `window['claude.web'].Launch.navigatePreview('preview-landing',${JSON.stringify(url + "/second")})`,
  );
  await other.waitFor(
    `window['claude.web'].Launch.previewSnapshot('preview-landing').then(s=>s.includes('SECOND_WINDOW_PAGE'))`,
    20000,
  );
  assert.ok(
    (
      await page.eval(
        `window['claude.web'].Launch.previewSnapshot('preview-landing')`,
      )
    ).includes("LANDING_BROWSER_PAGE"),
  );
  await other.eval(`window['claude.web'].Launch.stopServer('preview-landing')`);
  assert.ok(
    (
      await page.eval(
        `window['claude.web'].Launch.previewSnapshot('preview-landing')`,
      )
    ).includes("LANDING_BROWSER_PAGE"),
  );
  assert.deepEqual(
    await page.eval(
      `window['claude.web'].Launch.getPreviewNavState('unknown-retired-preview')`,
    ),
    { canGoBack: false, canGoForward: false },
  );
  assert.equal(
    await page.eval(
      `window['claude.web'].Launch.getPreviewUrl('unknown-retired-preview')`,
    ),
    null,
  );
  assert.deepEqual(
    await page.eval(
      `window['claude.web'].LocalSessions.getSessionList().then(r=>r.sessions.map(s=>s.sessionId).sort())`,
    ),
    before,
  );
  assert.deepEqual(
    client.gapsSince(0).filter((l) => /Launch|DraftBrowser/.test(l)),
    [],
  );
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "official homepage Browser button and address input, actual rendered page, isolated two-window drafts, stop, absent preview state and no conversation creation",
    }),
  );
} catch (error) {
  console.error(error);
  console.error(
    JSON.stringify({
      body: await page
        .eval("document.body.innerText.slice(-1800)")
        .catch(() => null),
      errors: client
        .logSince(0)
        .filter((l) => /Error|Launch/.test(l))
        .slice(-18),
    }),
  );
  process.exitCode = 1;
} finally {
  await page
    .eval(
      `window['claude.web'].Launch.stopServer('preview-landing').catch(()=>{})`,
    )
    .catch(() => {});
  await client.stop();
  await rm(path.dirname(client.logFile), { recursive: true, force: true });
  await new Promise((resolve) => web.close(resolve));
}
