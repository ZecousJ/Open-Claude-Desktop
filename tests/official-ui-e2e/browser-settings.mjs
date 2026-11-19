import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client, profile } from "./harness.mjs";
assert.ok(process.env.CLAUDEX_E2E_PROFILE, "Use a dedicated test account");
let client = await Client.launch();
let page = client.page(0);
const state = "window['claude.settings'].AppPreferences.getPreferences()";
const get = () => page.eval(state);
const toggle = `[...document.querySelectorAll('[role=dialog] [role=switch]')].filter(__e2e.visible).find(e=>e.getAttribute('aria-labelledby')?.split(' ').some(id=>document.getElementById(id)?.textContent.trim()==='Allow all browser actions'))`;
async function click() {
  await page.waitFor(`!!(${toggle})`);
  await page.eval(`(${toggle}).setAttribute('data-f075-browser','1')`);
  await page.click('[data-f075-browser="1"]');
  await page.eval(
    "document.querySelector('[data-f075-browser]')?.removeAttribute('data-f075-browser')",
  );
}
async function open() {
  await page.goto("/new");
  await page.eval("(location.hash='#settings/desktop',true)");
  await page.waitFor(`!!(${toggle})`);
}
const stored = () =>
  fs
    .readdirSync(path.join(profile, "profiles"))
    .map((id) => path.join(profile, "profiles", id, "settings.json"))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
    .find((s) => s.allowAllBrowserActions !== undefined);
try {
  await open();
  const initial = await get();
  assert.equal(initial.claudexBuiltInBrowserSettings, true);
  assert.equal(
    await page.eval(
      "[...document.querySelectorAll('[role=dialog]')].some(d=>d.innerText.includes('its built-in browser without asking'))",
    ),
    true,
  );
  assert.equal(
    await page.eval(
      "[...document.querySelectorAll('[role=dialog]')].some(d=>d.innerText.includes('Chrome instances signed in'))",
    ),
    false,
  );
  await click();
  await page.waitFor(
    `${state}.then(s=>s.allowAllBrowserActions===${!initial.allowAllBrowserActions})`,
  );
  assert.equal(
    stored().allowAllBrowserActions,
    !initial.allowAllBrowserActions,
  );
  await client.quit();
  client = await Client.launch();
  page = client.page(0);
  await open();
  assert.equal(
    (await get()).allowAllBrowserActions,
    !initial.allowAllBrowserActions,
  );
  assert.equal(
    await page.eval(`(${toggle}).getAttribute('aria-checked')`),
    String(!initial.allowAllBrowserActions),
  );
  await click();
  await page.waitFor(
    `${state}.then(s=>s.allowAllBrowserActions===${initial.allowAllBrowserActions})`,
  );
  console.log(
    "PASS: original System Browser use switch writes the built-in browser policy and survives cold reopen",
  );
} catch (error) {
  console.log(
    "Browser settings controls",
    await page
      .eval(
        "[...document.querySelectorAll('[role=dialog]')].filter(__e2e.visible).map(d=>d.innerText.split('\\n').filter(l=>/browser|system/i.test(l)))",
      )
      .catch(() => null),
  );
  throw error;
} finally {
  console.log("Evidence", client.logFile);
  await client.stop();
}
