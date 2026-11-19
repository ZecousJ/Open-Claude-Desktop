/** OS focus changes -> native IPC -> unchanged official CSS palette. */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "./harness.mjs";

process.env.CLAUDEX_OFFICIAL_UI_E2E_FOCUS = "1";
const client = await Client.launch();
try {
  const first = client.page(0),
    second = await client.openPage();
  const history = await first.eval(`window['claude.web'].LocalSessions.getSessionList().then(r=>r.sessions.find(s=>!s.isArchived))`);
  if (!history) throw Error("The test profile needs one existing Code session for sidebar verification.");
  const historyTitle = JSON.stringify(history.title.trim());
  await first.goto(`/epitaxy/${history.sessionId}`);
  await first.waitFor(`Array.from(document.querySelectorAll('.dframe-sidebar button')).some(b=>b.innerText.trim()===${historyTitle})`);
  await first.eval(`(()=>{const b=Array.from(document.querySelectorAll('.dframe-sidebar button')).find(b=>b.innerText.trim()===${historyTitle});b.setAttribute('data-focus-title','');return true})()`);
  const focus = async (page) => {
    const response = await fetch(
      `${client.origin}/__debug/focus?window=${page.windowId}`,
      { method: "POST", headers: { Cookie: client.cookie } },
    );
    assert.equal(response.status, 204);
    await page.waitFor(
      `document.hasFocus() && document.documentElement.getAttribute('data-window-active')!=='false'`,
      15000,
    );
  };
  const palette = (page) =>
    page.eval(
      `(()=>{const e=document.querySelector('.cds-root');const s=getComputedStyle(e);const title=document.querySelector('[data-focus-title]');return {active:document.documentElement.getAttribute('data-window-active')!=='false',fill:s.getPropertyValue('--cds-fill-accent').trim(),blue:s.getPropertyValue('--cds-blue-450').trim(),gray:s.getPropertyValue('--cds-gray-450').trim(),title:title?getComputedStyle(title).color:null}})()`,
    );
  await first.eval(
    `(()=>{window.__activity=[];window['claude.web'].WindowState.onWindowActiveChanged(active=>window.__activity.push(active));return true})()`,
  );
  await focus(first);
  const initial = await palette(first);
  assert.equal(initial.fill, initial.blue);
  await focus(second);
  await first.waitFor(
    `document.documentElement.getAttribute('data-window-active')==='false'`,
    15000,
  );
  const inactive = await palette(first);
  assert.equal(inactive.fill, inactive.gray);
  assert.notEqual(initial.title, inactive.title, "sidebar title must follow the official inactive ink rule");
  const other = await palette(second);
  assert.equal(other.fill, other.blue);
  await focus(first);
  const restored = await palette(first);
  assert.equal(restored.fill, restored.blue);
  assert.equal(restored.title, initial.title, "sidebar title brightness must recover after refocus");
  assert.deepEqual((await first.eval(`window.__activity`)).slice(-2), [
    false,
    true,
  ]);
  assert.equal(
    await first.eval(`window['claude.web'].WindowState.getWindowActive()`),
    true,
  );
  assert.equal(
    await second.eval(`window['claude.web'].WindowState.getWindowActive()`),
    false,
  );
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "two actual Electron windows, native OS focus, per-window IPC, official data-window-active, CSS blue/gray/blue and existing Code sidebar title dim/recovery",
      palette: {
        focused: initial.fill,
        blurred: inactive.fill,
        restored: restored.fill,
        titleFocused: initial.title,
        titleBlurred: inactive.title,
        titleRestored: restored.title,
      },
    }),
  );
} finally {
  await client.stop();
  await rm(path.dirname(client.logFile), { recursive: true, force: true });
}
