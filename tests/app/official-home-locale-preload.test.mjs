import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const html = fs.readFileSync("official-web.html", "utf8");
const source = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];

function prepare({ account = "41", locale = "zh-Hans", path = "/new", theme } = {}) {
  const values = new Map([
    ["claudex-web-account", account],
    ["claudex:official-owner:41", "owner-41"],
    ["claudex:official:owner-41:spa:account-locale", locale],
  ]);
  if (theme !== undefined)
    values.set("claudex:official:owner-41:LSS-userThemeMode", theme);
  const storage = { getItem: (key) => values.get(key) ?? null };
  const requests = [];
  const cachePolicies = [];
  const window = {};
  const document = {
    documentElement: { dataset: {}, style: { setProperty() {} } },
    querySelector: () => ({
      dataset: {
        i18nCatalogs: "zh-Hans:base123.dynamic456,en-US:english.base",
        i18nCut: "s/",
      },
    }),
  };
  vm.runInNewContext(source, {
    window,
    document,
    localStorage: storage,
    sessionStorage: storage,
    location: { pathname: path, search: "" },
    URLSearchParams,
    Response,
    fetch: (url, options) => {
      cachePolicies.push(options?.cache);
      requests.push(url);
      return Promise.resolve(new Response("{}"));
    },
  });
  return { window, requests, cachePolicies, dataset: document.documentElement.dataset };
}

test("the skeleton reads the official theme envelope for the selected account", () => {
  for (const theme of ["light", "dark"]) {
    for (const raw of [JSON.stringify({ value: theme }), JSON.stringify(theme), theme])
      assert.equal(prepare({ theme: raw }).dataset.theme, theme);
  }
  assert.equal(prepare({ theme: JSON.stringify({ value: "auto" }) }).dataset.theme, undefined);
  assert.equal(prepare({ account: "42", theme: JSON.stringify({ value: "dark" }) }).dataset.theme, undefined);
});

test("signed-in chat links show the chat skeleton before the host bundle", () => {
  const { dataset } = prepare({
    path: "/chat/7ac58659-733b-4800-b246-23d4fe59b304",
  });
  assert.equal(dataset.officialHomeBoot, "");
  assert.equal(dataset.officialBootRoute, "chat");
  assert.equal(prepare().dataset.officialBootRoute, "new");
  assert.equal(prepare({ account: "-" }).dataset.officialHomeBoot, undefined);
  assert.equal(prepare({ path: "/login" }).dataset.officialHomeBoot, undefined);
});

test("saved account locale starts and parses its verified catalogs before the host bundle", async () => {
  const { window, requests } = prepare();
  assert.deepEqual(requests, [
    "/i18n/s/zh-Hans.json?v=base123",
    "/i18n/dynamic/zh-Hans.json?v=dynamic456",
  ]);
  assert.equal(window.__claudexLocalePreload.locale, "zh-Hans");
  assert.deepEqual(await window.__claudexLocalePreload.bodies[requests[0]], {});
  assert.deepEqual(await window.__claudexLocalePreload.bodies[requests[1]], {});
});

test("sign-out, login, unknown locales and English do not prefetch a catalog", () => {
  for (const options of [
    { account: "-" },
    { path: "/login" },
    { locale: "../private" },
    { locale: "en-US" },
  ])
    assert.deepEqual(prepare(options).requests, []);
});


test("versioned locale preloads reuse the browser HTTP cache", () => {
  assert.deepEqual(prepare().cachePolicies, ["force-cache", "force-cache"]);
});
