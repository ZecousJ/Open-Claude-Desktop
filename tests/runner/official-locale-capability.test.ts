/** Inert authenticated route, real temporary Store and delivered catalogs. No remote account/model calls. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultSettings, Store } from "../../electron/store/store";
import { officialUiRead } from "../../runner/src/official-ui-read";
import { negotiatedAppearanceSettings } from "../../src-web/official/negotiated-appearance-action";
import {
  officialAppearanceCapabilitiesPath,
  validLocaleBody,
  isOfficialLocaleAction,
} from "../../shared/official-appearance-capability";
import {
  officialLocaleMessages,
  officialLocales,
} from "../../electron/official-ui/locale";
import { encodeWireValue } from "../../shared/web-wire";
import { defaultGuardOptions } from "../../runner/src/method-guard";
import { openPolicy } from "../../shared/client-policy";
import { settingsSchema } from "../../electron/store/settings-schema";
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const request = (body: unknown) => ({
  method: "PUT" as const,
  path: "/api/account_profile",
  contentType: "application/json",
  body: json(body),
});
function fixture(t: any, assets = path.resolve("build/official-ui")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "locale-capability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root) as Store & {
    persistAppearancePreference(): Promise<void>;
  };
  store.settings = { ...store.settings, locale: "en-US" } as any;
  let identity: unknown = {},
    enabled = true,
    fail = false,
    flushes = 0,
    events = 0;
  store.persistAppearancePreference = async () => {
    flushes++;
    if (fail) throw Error("inert disk failure");
    store.flush();
  };
  const ctx: any = {
    userId: 1,
    activeAccount: { id: "owner" },
    officialSessionIdentity: () => identity,
    setAccessToken() {},
    onEvent: () => () => {},
    appVersion: "inert",
    log() {},
    policy: () => openPolicy,
    store,
    settingsListeners: {
      emit() {
        events++;
      },
    },
  };
  const dispatcher: any = {
    options: {
      officialUiRoot: assets,
      officialUiActions: false,
      get officialUiAppearanceSettings() {
        return enabled;
      },
    },
    guard: defaultGuardOptions,
    context: () => ctx,
    contextFor: async () => ctx,
    now: () => 1,
    run: async () => {
      throw Error("General dispatch is not authorized");
    },
  };
  const run = (r: any) =>
    officialUiRead(dispatcher, {
      t: "call",
      id: "fixture",
      user: { id: 1, accessToken: "inert-fixture" },
      method: r.method === "GET" ? "officialUiRead" : "officialUiAction",
      args: encodeWireValue([r]),
    } as any) as Promise<any>;
  const cap = async () =>
    JSON.parse(
      Buffer.from(
        (await run({ method: "GET", path: officialAppearanceCapabilitiesPath }))
          .body,
      ).toString(),
    );
  return {
    root,
    store,
    ctx,
    run,
    cap,
    retire: () => (identity = {}),
    disable: () => (enabled = false),
    fail: () => (fail = true),
    counts: () => ({ flushes, events }),
  };
}
test("locale changes accept the original picker codes and only the locale field", () => {
  for (const locale of ["zh-Hans", "zh-Hant"]) {
    assert.equal(validLocaleBody({ locale }), true);
    assert.equal(
      settingsSchema.parse({ ...defaultSettings, locale }).locale,
      locale,
    );
  }
  for (const locale of ["zh-CN", "ar", "../fr-FR"])
    assert.equal(validLocaleBody({ locale }), false);
  for (const body of [
    { locale: "fr-FR", display_name: "x" },
    { locale: "fr-FR", avatar: "x" },
    { locale: ["fr-FR"] },
    { locale: "fr-FR", full_name: "x" },
  ])
    assert.equal(validLocaleBody(body), false);
  assert(!isOfficialLocaleAction("PATCH", "/api/account_profile"));
  assert(!isOfficialLocaleAction("PUT", "/api/account_profile?x=1"));
  const en = officialLocaleMessages(path.resolve("build/official-ui"), "en-US"),
    fr = officialLocaleMessages(path.resolve("build/official-ui"), "fr-FR");
  assert.equal(typeof en["y1Z3orIe9Z"], "string");
  assert.equal(typeof fr["y1Z3orIe9Z"], "string");
  assert.notEqual(en["y1Z3orIe9Z"], fr["y1Z3orIe9Z"]);
});

test("bootstrap defaults to a delivered Simplified Chinese pair and preserves a language selected through the runner", async (t) => {
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), "locale-assets-"));
  t.after(() => fs.rmSync(assets, { recursive: true, force: true }));
  const catalogs = path.join(assets, "ui/i18n");
  fs.mkdirSync(path.join(catalogs, "dynamic"), { recursive: true });
  fs.mkdirSync(path.join(assets, "data"));
  const released = ["en-US", "zh-Hans", "zh-Hant", "ar"];
  fs.writeFileSync(
    path.join(assets, "data/bootstrap-defaults.json"),
    JSON.stringify({
      org_growthbook: {
        features: { "2420925338": { defaultValue: { released } } },
      },
    }),
  );
  const writeCatalog = (file: string) =>
    fs.writeFileSync(path.join(catalogs, file), '{"example":"message"}');
  for (const locale of released) {
    writeCatalog(`${locale}.json`);
    if (locale === "en-US" || locale === "ar")
      writeCatalog(`dynamic/${locale}.json`);
  }
  const f = fixture(t, assets);
  delete f.store.settings.locale;
  const bootstrap = async () => {
    const answer = await f.run({ method: "GET", path: "/edge-api/bootstrap" });
    assert.equal(answer.status, 200, Buffer.from(answer.body).toString());
    return JSON.parse(Buffer.from(answer.body).toString());
  };
  let boot = await bootstrap();
  assert.equal(boot.locale, "en-US");
  assert.deepEqual(
    boot.growthbook.features["2420925338"].defaultValue.released,
    ["en-US"],
  );
  writeCatalog("dynamic/zh-Hans.json");
  boot = await bootstrap();
  assert.equal(boot.locale, "zh-Hans");
  assert.equal(boot.account.settings.locale, "zh-Hans");
  assert.equal(boot.gated_messages.locale, "zh-Hans");
  assert.equal(boot.locale_source, undefined);
  assert.deepEqual(
    boot.growthbook.features["2420925338"].defaultValue.released,
    ["en-US", "zh-Hans"],
  );
  assert.deepEqual(officialLocales(assets), ["en-US", "zh-Hans"]);
  assert.deepEqual((await f.cap()).locales, ["en-US", "zh-Hans"]);
  assert.equal(f.store.settings.locale, undefined);
  f.store.settings.locale = "zh-CN";
  boot = await bootstrap();
  assert.equal(boot.locale, "zh-Hans");
  assert.equal(boot.locale_source, "user_choice");
  delete f.store.settings.locale;
  const run = negotiatedAppearanceSettings({
    enabled: true,
    accountId: "1",
    current: () => true,
    read: f.run,
    action: f.run,
  });
  assert.equal((await run(request({ locale: "zh-Hant" }))).status, 501);
  writeCatalog("dynamic/zh-Hant.json");
  for (const locale of ["en-US", "zh-Hant", "zh-Hans"]) {
    const answer = await run(request({ locale }));
    assert.equal(answer.status, 200, Buffer.from(answer.body).toString());
    f.store.settings = new Store(f.root).settings;
    assert.equal(f.store.settings.locale, locale);
    boot = await bootstrap();
    assert.equal(boot.locale, locale);
    assert.equal(boot.locale_source, "user_choice");
  }
});
test("actual client negotiation and runner route save en↔fr to a real Store and reopen the selected catalog", async (t) => {
  const f = fixture(t);
  const run = negotiatedAppearanceSettings({
    enabled: true,
    accountId: "1",
    current: () => true,
    read: f.run,
    action: f.run,
  });
  for (const locale of ["fr-FR", "en-US"]) {
    const answer = await run(request({ locale }));
    assert.equal(answer.status, 200, Buffer.from(answer.body).toString());
    assert.equal(
      JSON.parse(Buffer.from(answer.body).toString()).locale,
      locale,
    );
    assert.equal((new Store(f.root).settings as any).locale, locale);
    assert.equal(f.store.settings.instructions, "");
    assert.equal(f.store.settings.name, "Zecous");
    assert.equal(
      typeof officialLocaleMessages(path.resolve("build/official-ui"), locale)[
        "y1Z3orIe9Z"
      ],
      "string",
    );
  }
  assert.deepEqual(f.counts(), { flushes: 2, events: 2 });
});
test("default off, stale lease, mixed profile fields, missing locale capability and failed persistence do not acknowledge a language save", async (t) => {
  const f = fixture(t),
    cap = await f.cap();
  let answer = await f.run({
    ...request({ locale: "fr-FR", display_name: "NO" }),
    capabilityLease: cap.activationLease,
  });
  assert.equal(answer.status, 400);
  f.retire();
  answer = await f.run({
    ...request({ locale: "fr-FR" }),
    capabilityLease: cap.activationLease,
  });
  assert.equal(answer.status, 409);
  const fresh = await f.cap();
  f.fail();
  answer = await f.run({
    ...request({ locale: "fr-FR" }),
    capabilityLease: fresh.activationLease,
  });
  assert.equal(answer.status, 400);
  assert.equal((f.store.settings as any).locale, "en-US");
  assert.deepEqual(f.counts(), { flushes: 1, events: 0 });
  f.disable();
  await assert.rejects(() =>
    f.run({
      ...request({ locale: "fr-FR" }),
      capabilityLease: fresh.activationLease,
    }),
  );
  let actions = 0;
  const old = { ...fresh };
  delete old.locales;
  const client = negotiatedAppearanceSettings({
    enabled: true,
    accountId: "1",
    current: () => true,
    read: async () => ({
      status: 200,
      contentType: "application/json",
      body: json(old),
    }),
    action: async () => {
      actions++;
      throw Error("unexpected");
    },
  });
  assert.equal((await client(request({ locale: "fr-FR" }))).status, 501);
  assert.equal(actions, 0);
});

import { saveAppearanceLocale } from "../../runner/src/official-ui-appearance-save";
import { accountRoute } from "../../electron/official-ui/api/account";
import { Readable } from "node:stream";
test("pending locale confirmation cannot acknowledge a superseded selection or retired activation", async () => {
  for (const retire of [false, true]) {
    let release!: () => void,
      current = true,
      events = 0;
    const store: any = {
      settings: { locale: "en-US", providers: [], instructions: "keep" },
      persistAppearancePreference: () =>
        new Promise<void>((r) => (release = r)),
    };
    const first = saveAppearanceLocale({
      locale: "fr-FR",
      store,
      current: () => current,
      policy: openPolicy,
      changed() {
        events++;
      },
    });
    if (retire) current = false;
    else
      store.settings = {
        ...store.settings,
        locale: "ja-JP",
        instructions: "new",
      };
    release();
    await assert.rejects(first, /changed/);
    assert.equal(events, 0);
    assert.equal(store.settings.locale, retire ? "fr-FR" : "ja-JP");
  }
});
test("native profile keeps existing local save contract, confirms disk reopening, and never reports flush failure as success", async (t) => {
  const f = fixture(t);
  let fail = false,
    identity: unknown = {};
  const ctx: any = {
    root: path.resolve("build/official-ui"),
    account: () => ({ id: "owner" }),
    settings: () => f.store.settings,
    sessionIdentity: () => identity,
    isCurrent: () => true,
    localCall: async (method: string, next: any) => {
      assert.equal(method, "saveSettings");
      f.store.settings = next;
      if (fail) throw Error("inert native flush failure");
      f.store.flush();
    },
    call: async () => {
      throw Error("No remote mutation");
    },
  };
  const put = async (body: any) => {
    const req = Readable.from([json(body)]) as any;
    req.method = "PUT";
    req.headers = { "content-type": "application/json" };
    let status = 0,
      response = "";
    const res: any = {
      writeHead(s: number) {
        status = s;
      },
      end(v: any) {
        response = String(v ?? "");
      },
    };
    assert.equal(
      await accountRoute(req, res, "/api/account_profile", ctx),
      true,
    );
    return { status, response };
  };
  assert.equal((await put({ locale: "fr-FR" })).status, 200);
  assert.equal((new Store(f.root).settings as any).locale, "fr-FR");
  fail = true;
  assert.equal((await put({ locale: "en-US" })).status, 400);
  assert.equal((new Store(f.root).settings as any).locale, "fr-FR");
  // Memory may differ after an uncertain failed flush; do not describe this as a successful save or retry it.
  assert.equal((f.store.settings as any).locale, "en-US");
  const before = f.counts();
  assert.equal((await put({ locale: "ar" })).status, 400);
  assert.deepEqual(f.counts(), before);
});

test("failed cosmetic persistence cannot roll back a retired or same-store reactivated account", async () => {
  const { saveAppearanceFont, saveAppearanceLocale } = await import("../../runner/src/official-ui-appearance-save");
  for (const kind of ["font", "locale"] as const) {
    for (const reactivate of [false, true]) {
      let generation = 1;
      const captured = generation;
      let reject!: (error: Error) => void;
      const store: any = {
        settings: { locale: "en-US", chatFont: "sans" },
        persistAppearancePreference: () => new Promise<void>((_, fail) => { reject = fail; }),
      };
      const input = {
        store, policy: openPolicy, current: () => generation === captured,
        changed() { assert.fail("Retired persistence must not emit success"); },
      };
      const pending = kind === "font"
        ? saveAppearanceFont({ ...input, font: "serif" })
        : saveAppearanceLocale({ ...input, locale: "fr-FR" });
      const assigned = store.settings;
      generation = 2;
      if (reactivate) generation = 3; // Same Store and account reused, but not the original activation.
      reject(Error("inert persistence rejection"));
      await assert.rejects(pending, /inert persistence rejection/);
      assert.equal(store.settings, assigned, "Old operation cannot alter the current activation's memory");
    }
  }
});
