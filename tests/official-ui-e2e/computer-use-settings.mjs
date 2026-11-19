import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client, profile } from "./harness.mjs";

assert.ok(process.env.CLAUDEX_E2E_PROFILE, "An isolated test account is required");
const client = await Client.launch();
const page = client.page(0);
const preferences = "window['claude.settings'].AppPreferences";
const readPreferences = () => page.eval(`${preferences}.getPreferences()`);
const checkPreference = (key, value) => page.waitFor(
  `${preferences}.getPreferences().then(p=>JSON.stringify(p[${JSON.stringify(key)}])===${JSON.stringify(JSON.stringify(value))})`,
);
async function clickControl(text, type) {
  const selector = type === "switch" ? "[role=switch]" : "button,[role=option],[role=menuitem],[role=radio]";
  await page.waitFor(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(__e2e.visible).find(e=>!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&[e.getAttribute('aria-label'),...(e.getAttribute('aria-labelledby')??'').split(' ').map(id=>document.getElementById(id)?.textContent),...e.innerText.split('\\n')].some(label=>label?.trim()===${JSON.stringify(text)}));if(!e)return false;e.dataset.f075Target='1';return true})()`);
  await page.click('[data-f075-target="1"]');
  await page.eval("document.querySelectorAll('[data-f075-target]').forEach(e=>delete e.dataset.f075Target)");
}

try {
  await page.goto("/new");
  await page.eval("(location.hash='#settings/desktop',true)");
  const initial = await readPreferences();
  assert.equal(initial.chicagoEnabled, false);
  const tcc = await page.eval("window['claude.web'].ComputerUseTcc.getState()");
  assert.deepEqual(Object.keys(tcc).sort(), ["accessibility", "microphone", "screenRecording"]);
  console.log("Host permission state", JSON.stringify(tcc));
  await clickControl("Enable computer use", "switch");
  await clickControl("Turn on");
  await checkPreference("chicagoEnabled", true);
  const files = fs.readdirSync(path.join(profile, "profiles"))
    .map(id => path.join(profile, "profiles", id, "computer-use.json"))
    .filter(file => fs.existsSync(file));
  assert.equal(files.length, 1);
  const disk = () => JSON.parse(fs.readFileSync(files[0], "utf8"));
  assert.equal(disk().enabled, true);
  console.log("PASS: original Settings enables the account computer-use broker");

  if (process.platform === "darwin") {
    await clickControl("Unhide apps when Claudex finishes", "switch");
    await checkPreference("chicagoAutoUnhide", false);
    assert.equal(disk().unhideApps, false);
    await clickControl("Full control");
    await checkPreference("chicagoPreferredMode", "full_control");
    assert.equal(disk().mode, "fullControl");
    await clickControl("Background");
    await checkPreference("chicagoPreferredMode", "background");
    await clickControl("Add app");
    await clickControl("TextEdit");
    await checkPreference("chicagoUserDeniedBundleIds", ["com.apple.TextEdit"]);
    assert.deepEqual(disk().deniedApps.map(app => app.id), ["com.apple.TextEdit"]);
    await clickControl("Remove TextEdit from deny list");
    await checkPreference("chicagoUserDeniedBundleIds", []);
    assert.deepEqual(disk().deniedApps, []);
    console.log("PASS: original mode, auto-unhide and deny-list controls reach the native account settings");
  }

  await clickControl("Enable computer use", "switch");
  await checkPreference("chicagoEnabled", false);
  assert.equal(disk().enabled, false);
  const ordinary = JSON.parse(fs.readFileSync(path.join(path.dirname(files[0]), "settings.json"), "utf8"));
  assert.equal(ordinary.computerAccess, undefined);
  console.log("PASS: disabling computer use leaves the Cowork device preference alone");
} finally {
  console.log("Client evidence", client.logFile);
  await client.stop();
}
