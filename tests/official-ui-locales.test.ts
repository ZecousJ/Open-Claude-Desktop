import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { registerDesktopIntl } from "../electron/official-ui/native/intl";
import { accountRoute } from "../electron/official-ui/api/account";
import {
  officialLocale,
  officialLocaleMessages,
} from "../electron/official-ui/locale";
import { accountOf, bootstrapOf } from "../electron/official-ui/api/bootstrap";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-locales-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const part of ["", "dynamic"]) {
    const dir = path.join(root, "ui/i18n", part);
    fs.mkdirSync(dir, { recursive: true });
    for (const locale of ["en-US", "fr-FR"])
      fs.writeFileSync(
        path.join(dir, `${locale}.json`),
        JSON.stringify({ [part || "base"]: locale }),
      );
  }
  let settings: any = { locale: "en-US", providers: [] };
  let identity = {};
  let readOnly = false;
  const listeners: ((event: any) => void)[] = [];
  const saved: any[] = [];
  const ctx = {
    root,
    account: () => ({
      id: "one",
      name: "Fixture",
      email: "fixture@example.invalid",
    }),
    sessionIdentity: () => identity,
    settings: () => settings,
    get readOnly() {
      return readOnly;
    },
    localCall: async (name: string, next: any) => {
      assert.equal(name, "saveSettings");
      settings = next;
      saved.push(next);
      for (const fn of listeners) fn({ type: "settings", settings });
    },
    call: async () => {
      throw Error("Locale must use device-local settings");
    },
    onEvent(fn: (event: any) => void) {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
  };
  return {
    root,
    ctx,
    saved,
    listeners,
    settings: () => settings,
    switchAccount: () => {
      identity = {};
    },
    restrict: () => {
      readOnly = true;
    },
  };
}

test("locale HTTP saves to the local account and all native windows receive the official event shape", async (t) => {
  const f = fixture(t);
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: any[] = [];
  const dispose = registerDesktopIntl({
    ctx: f.ctx,
    on(name: string, fn: any) {
      handlers.set(name, fn);
    },
    emit: (...args: any[]) => events.push(args),
  } as never);
  const initial = handlers.get("DesktopIntl.getInitialLocale")!;
  assert.deepEqual(initial(), {
    locale: "en-US",
    messages: { base: "en-US", dynamic: "en-US" },
  });
  const server = http.createServer(
    (req, res) =>
      void accountRoute(
        req,
        res,
        new URL(req.url!, "http://localhost").pathname,
        f.ctx as never,
      ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/account_profile`;
  const put = (body: unknown) =>
    fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const response = await put({ locale: "fr-FR" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).locale, "fr-FR");
  assert.equal(f.settings().locale, "fr-FR");
  assert.equal(accountOf(f.ctx as never)?.settings.locale, "fr-FR");
  const bootstrap = await bootstrapOf({
    ...f.ctx,
    modelCatalog: async () => null,
    log() {},
  } as never);
  assert.equal(bootstrap.locale, "fr-FR");
  assert.equal(
    bootstrap.gated_messages.locale,
    bootstrap.locale,
    "a mismatched bootstrap locale silently leaves the UI in English",
  );
  assert.deepEqual(events.at(-1), [
    "DesktopIntl",
    "localeChanged",
    "fr-FR",
    { base: "fr-FR", dynamic: "fr-FR" },
  ]);
  await handlers.get("DesktopIntl.requestLocaleChange")!("fr-FR");
  assert.equal(
    f.saved.length,
    1,
    "bootstrap synchronization must not save repeatedly",
  );
  assert.equal(
    events.length,
    1,
    "unchanged language does not send duplicate events",
  );
  const count = f.saved.length;
  for (const locale of ["../en-US", "zh-Hans", {}, null]) {
    assert.equal(
      (await put({ locale, display_name: "Must not change" })).status,
      400,
    );
    assert.equal(f.saved.length, count);
  }
  f.restrict();
  assert.equal(
    (await put({ locale: "en-US", display_name: "Must not change" })).status,
    400,
  );
  assert.equal(f.saved.length, count);
  dispose();
  assert.equal(f.listeners.length, 0);
});

test("a stale window cannot overwrite the saved language and invalid catalogs are refused", async (t) => {
  const f = fixture(t);
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: any[] = [];
  registerDesktopIntl({
    ctx: f.ctx,
    on: (name: string, fn: any) => handlers.set(name, fn),
    emit: (...args: any[]) => events.push(args),
  } as never);
  await f.ctx.localCall("saveSettings", { locale: "fr-FR" });
  f.switchAccount();
  handlers.get("DesktopIntl.requestLocaleChange")!("en-US");
  assert.equal(f.saved.length, 1);
  assert.equal(f.settings().locale, "fr-FR");
  assert.equal(events.at(-1)[2], "fr-FR");
  assert.throws(
    () => officialLocaleMessages(f.root, "../../secret"),
    /not available/,
  );
  fs.writeFileSync(path.join(f.root, "ui/i18n/fr-FR.json"), '["bad"]');
  assert.throws(() => officialLocaleMessages(f.root, "fr-FR"), /invalid/);
  fs.rmSync(path.join(f.root, "ui/i18n/fr-FR.json"));
  assert.throws(() => officialLocaleMessages(f.root, "fr-FR"), /not available/);
  assert.equal(
    officialLocale({
      root: f.root,
      settings: () => ({ locale: "zh-CN" }),
    } as never),
    "en-US",
  );
});

test("bootstrap releases only captured languages with both delivered catalogs", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "data"));
  fs.writeFileSync(path.join(f.root, "ui/i18n/de-DE.json"), "{}");
  fs.writeFileSync(path.join(f.root, "ui/i18n/ru.json"), "{}");
  fs.writeFileSync(path.join(f.root, "ui/i18n/dynamic/ru.json"), "{}");
  fs.writeFileSync(
    path.join(f.root, "data/bootstrap-defaults.json"),
    JSON.stringify({
      org_growthbook: {
        features: {
          "2420925338": {
            defaultValue: {
              released: ["en-US", "de-DE", "fr-FR", "zh-Hans", "ru"],
            },
            rules: [{ force: { released: ["zh-Hans"] } }],
          },
        },
      },
    }),
  );
  const bootstrap = await bootstrapOf({
    ...f.ctx,
    modelCatalog: async () => null,
    log() {},
  } as never);
  const expected = { defaultValue: { released: ["en-US", "fr-FR"] } };
  assert.deepEqual(bootstrap.growthbook.features["2420925338"], expected);
  assert.deepEqual(bootstrap.org_growthbook.features["2420925338"], expected);
});
