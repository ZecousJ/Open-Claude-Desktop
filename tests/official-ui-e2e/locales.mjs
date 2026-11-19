/** Official language picker, recovered official catalogs and persistent local
 * account settings. No model calls and no changes to the user's main profile. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client, profile } from "./harness.mjs";

let client = await Client.launch();
let page = client.page(0);
let originalLocale;
let originalStorage;
let restore = false;
const logs = [];
const catalogRoot = path.resolve("build/official-ui/ui/i18n");
const chineseLocales = ["zh-Hans", "zh-Hant"];
const deliveredChineseLocales = chineseLocales.filter((locale) =>
  [`${locale}.json`, `dynamic/${locale}.json`].every((file) =>
    fs.existsSync(path.join(catalogRoot, file)),
  ),
);
const message = (locale, prefix, fallback) => {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(catalogRoot, `${locale}.json`), "utf8"),
  );
  const keys = Object.keys(catalog).filter((id) => id.startsWith(prefix));
  return keys.length === 1 ? catalog[keys[0]] : fallback;
};
async function debugCall(name, args = []) {
  const response = await fetch(`${client.origin}/__debug/call`, {
    method: "POST",
    headers: { Cookie: client.cookie, "content-type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const json = await response.json();
  if (!response.ok || json.error)
    throw Error(`Test settings operation failed: ${name}`);
  return json.value;
}
async function openLanguage(locale) {
  await page.eval("__e2e.closeMenus()");
  await page.click('[data-testid="user-menu-button"]');
  const label = message(locale, "ke/5wp", "Language");
  await page.waitFor(
    `(()=>{const e=__e2e.all('[role=menuitem]').find(e=>__e2e.visible(e)&&e.innerText.replace(/[\\uE000-\\uF8FF]/g,'').trim()===${JSON.stringify(label)});if(!e)return false;e.dataset.e2eLanguage='1';return true})()`,
  );
  await page.click('[data-e2e-language="1"]');
  await page.waitFor("!!document.querySelector('[data-cds=LanguagePicker]')");
}
try {
  const account = (await page.api("/api/account")).body;
  assert.match(account.uuid, /^[\w-]+$/);
  const saved = JSON.parse(
    fs.readFileSync(
      path.join(profile, "profiles", account.uuid, "settings.json"),
      "utf8",
    ),
  );
  originalLocale = saved.locale;
  originalStorage = await page.eval(
    "Object.fromEntries(['spa:locale','spa:locale-source','spa:account-locale'].map(k=>[k,localStorage.getItem(k)]))",
  );
  restore = true;
  let current = (await page.api("/api/account_profile")).body.locale;
  if (originalLocale === undefined && deliveredChineseLocales.includes("zh-Hans")) {
    assert.equal(current, "zh-Hans");
    await page.waitFor("document.documentElement.lang==='zh-Hans'", 30000);
  }
  const languages = [
    "fr-FR",
    "de-DE",
    "ja-JP",
    "ko-KR",
    "it-IT",
    "pt-BR",
    "es-419",
    "es-ES",
    "hi-IN",
    "id-ID",
    ...deliveredChineseLocales,
    "en-US",
  ];
  const restartLocale = deliveredChineseLocales.includes("zh-Hans")
    ? "zh-Hans"
    : "fr-FR";
  for (const locale of languages) {
    await openLanguage(current);
    await page.waitFor(
      `(()=>{const e=__e2e.all('[data-cds=LanguagePicker] [role=radio]').find(e=>e.lang===${JSON.stringify(locale)}||e.querySelector('[lang="${locale}"]'));if(!e)return false;e.dataset.e2eLocale='1';return true})()`,
    );
    await page.click('[data-e2e-locale="1"]');
    await page.waitFor(
      `document.documentElement.lang===${JSON.stringify(locale)} && !document.querySelector('[data-cds=LanguagePicker]')`,
      30000,
    );
    assert.equal((await page.api("/api/account_profile")).body.locale, locale);
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(profile, "profiles", account.uuid, "settings.json"),
          "utf8",
        ),
      ).locale,
      locale,
    );
    const native = await page.eval(
      "window.electronIntl.getInitialLocale().then(r=>({locale:r.locale,messages:Object.keys(r.messages).length}))",
    );
    assert.equal(native.locale, locale);
    assert.ok(native.messages > 1000);
    await page.click('[data-testid="user-menu-button"]');
    const settingsLabel = message(locale, "jqhhMI", "Settings");
    await page.waitFor(
      `__e2e.all('[role=menuitem]').some(e=>__e2e.visible(e)&&e.innerText.includes(${JSON.stringify(settingsLabel)}))`,
    );
    await page.eval("__e2e.closeMenus()");
    await page.goto("/new");
    await page.waitFor(
      `document.documentElement.lang===${JSON.stringify(locale)}`,
      30000,
    );
    current = locale;
    if (locale === restartLocale) {
      logs.push(client.logFile);
      await client.stop();
      client = await Client.launch();
      page = client.page(0);
      await page.waitFor(
        `document.documentElement.lang===${JSON.stringify(locale)}`,
        30000,
      );
      assert.equal(
        (await page.api("/api/account_profile")).body.locale,
        locale,
      );
      console.log(
        `PASS ${locale}: official picker, translated menu, saved profile, reload and full client restart.`,
      );
    } else
      console.log(
        `PASS ${locale}: official picker, translated menu, local persistence and reload.`,
      );
  }
  for (const locale of chineseLocales.filter(
    (locale) => !deliveredChineseLocales.includes(locale),
  )) {
    const unavailable = await page.api("/api/account_profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale }),
    });
    assert.equal(unavailable.status, 400);
    assert.equal((await page.api("/api/account_profile")).body.locale, "en-US");
    console.log(`PASS ${locale}: unavailable language preserves the saved language.`);
  }
} catch (error) {
  console.error("Language UI failure:", error.message);
  console.error(
    await page
      .eval(
        "({lang:document.documentElement.lang,menus:__e2e.all('[role=menu],[data-cds=LanguagePicker]').filter(__e2e.visible).map(e=>e.innerText.replace(/[\\w.+-]+@[\\w.-]+/g,'[account]').slice(0,1500))})",
      )
      .catch(() => null),
  );
  throw error;
} finally {
  try {
    if (restore) {
      const snapshot = await debugCall("snapshot");
      await debugCall("saveSettings", [
        { ...snapshot.settings, locale: originalLocale },
      ]);
      await page.eval(
        `(()=>{for(const [k,v] of Object.entries(${JSON.stringify(originalStorage)})){if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v)}return true})()`,
      );
    }
  } finally {
    logs.push(client.logFile);
    console.log("Client evidence:", logs.join(", "));
    await client.stop();
  }
}
