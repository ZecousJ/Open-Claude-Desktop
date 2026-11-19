import assert from "node:assert/strict";
import { Client, profile } from "./harness.mjs";
import fs from "node:fs";
import path from "node:path";
assert.ok(
  process.env.CLAUDEX_E2E_PROFILE,
  "Use an isolated profile with the F118 fixture",
);
let client = await Client.launch();
let page = client.page(0);
const id = "local_009b74bf-f82d-44ad-9d21-337dc5032d07";
const api = "window['claude.web'].LocalAgentModeSessions";
const models = "[data-testid=model-selector-dropdown]";
const controls =
  "[role=menuitem],[role=menuitemradio],[role=option],[role=radio],button";
async function clickText(t) {
  await page.waitFor(
    `(()=>{const row=[...document.querySelectorAll(${JSON.stringify(controls)})].filter(__e2e.visible).filter(e=>!e.disabled&&e.getAttribute('aria-disabled')!=='true').filter(e=>e.innerText.trim().split('\\n').some(s=>s.trim()===${JSON.stringify(t)})); const e=row.find(e=>e.matches('[role=menuitem],[role=menuitemradio],[role=option],[role=radio]'))??row.at(-1);if(!e)return false;e.dataset.f118Action='1';return true})()`,
  );
  await page.click('[data-f118-action="1"]');
  await page.eval(
    "document.querySelectorAll('[data-f118-action]').forEach(e=>delete e.dataset.f118Action)",
  );
}
try {
  await page.goto("/cowork/" + id);
  await page.eval(
    "[...document.querySelectorAll('[role=dialog] button[aria-label=Close]')].filter(__e2e.visible).forEach(e=>e.click())",
  );
  await page.click(models);
  await clickText("GPT-5.4");
  await clickText("Switch to GPT-5.4");
  await page.waitFor(
    `document.querySelector('${models}')?.getAttribute('aria-label')?.includes('GPT-5.4')`,
  );
  await page.click(models);
  await clickText("Effort");
  await page.click("[data-effort-id=low]");
  const choice = await page.waitFor(`(()=>{
    if(document.querySelector('${models}')?.getAttribute('aria-label')?.includes('Low'))return 'selected';
    if([...document.querySelectorAll('button')].some(b=>__e2e.visible(b)&&b.innerText.trim()==='Switch to Low'))return 'confirm';
  })()`);
  if (choice === "confirm") await clickText("Switch to Low");
  await page.waitFor(
    `document.querySelector('${models}')?.getAttribute('aria-label')?.includes('Low')`,
  );
  await page.eval("__e2e.type('F114_FOLLOW F118 exact picker acceptance')");
  await page.waitFor(
    "(()=>{const b=[...document.querySelectorAll('main button')].filter(__e2e.visible).find(b=>!b.disabled&&/^(Send|Send message)$/.test(b.getAttribute('aria-label')??''));if(!b)return false;b.dataset.f118Send='1';return true})()",
  );
  await page.eval("document.querySelector('[data-f118-send]').click()");
  await page.waitFor(
    "document.querySelector('main')?.innerText.includes('F114_FOLLOWUP_READY')",
    45000,
  );
  const saved = await page.eval(
    `${api}.getSession(${JSON.stringify(id)}).then(s=>({model:s.model,effort:s.effortLevel}))`,
  );
  assert.deepEqual(saved, { model: "gpt-5.4", effort: "low" });
  console.log("Session settings", saved);
  const rows = fs
    .readFileSync(path.join(profile, "f114-stream.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(
    rows.some(
      (r) =>
        r.marker === "FOLLOW" &&
        r.model === "gpt-5.4" &&
        r.effort === "low" &&
        r.tools > 0,
    ),
  );
  await client.quit();
  client = await Client.launch();
  page = client.page(0);
  await page.goto("/cowork/" + id);
  await page.waitFor(
    "document.querySelector('main')?.innerText.includes('F114_FOLLOWUP_READY')",
  );
  assert.deepEqual(
    await page.eval(
      `${api}.getSession(${JSON.stringify(id)}).then(s=>({model:s.model,effort:s.effortLevel}))`,
    ),
    saved,
  );
  console.log(
    "PASS: original picker, GPT-5.4/Low model request and cold reopen",
  );
} finally {
  console.log("Evidence", client.logFile);
  await client.stop();
}
