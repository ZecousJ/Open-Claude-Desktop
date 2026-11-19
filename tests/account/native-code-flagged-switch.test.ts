import * as accelerator from "../../shared/accelerator";
import { desktopPreferences } from "../../electron/store/desktop-preferences";
import { accountOf } from "../../electron/official-ui/api/bootstrap";
import { saveOfficialCodeFlaggedSwitch } from "../../electron/official-ui/api/classification-settings";
/** Actual native saveSettings and desktop integrations; inert Electron, temporary Store. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { isDeepStrictEqual } from "node:util";
import * as preferences from "../../shared/settings-extras";
import * as shortcuts from "../../electron/app/desktop-shortcut-error";
import { z } from "zod";
import { Store } from "../../electron/store/store";
import { settingsSchema } from "../../electron/store/settings-schema";
import { mergeSavedSettings } from "../../electron/store/settings-merge";
import { withoutPreferences } from "../../electron/store/settings-preferences";
import { settingsRefusal, openPolicy } from "../../shared/client-policy";
import { preference } from "../../shared/settings-extras";
import {
  localeSaveStage,
  localeSaveFailure,
} from "../../electron/official-ui/api/locale-save-diagnostics";
const assets = path.resolve("build/official-ui");
test("code-flagged-switch-only real handler persists without retrying unrelated shortcuts; mixed writes and tray errors remain failures", async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "actual-code-flagged-switch-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.settings = {
    ...store.settings,
    modelAutoFallback: false,
    locale: "en-US",
  } as any;
  store.flush();
  let applyFailure = false,
    save: any;
  const calls: string[] = [];
  let shortcutAttempts = 0;
  function load(file: string, deps: Record<string, any>) {
    const exports: any = {};
    vm.runInNewContext(
      ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
      {
        exports,
        require: (key: string) => deps[key] ?? {},
        process: { platform: "linux" },
        setTimeout,
        clearTimeout,
      },
    );
    return exports;
  }
  const tray = load("electron/app/desktop-tray-dock.ts", {
    "./desktop-shortcut-error": shortcuts,
    "../../shared/accelerator": accelerator,
    "../../shared/settings-extras": preferences,
    electron: {
      globalShortcut: {
        register: () => {
          shortcutAttempts++;
          return false;
        },
        unregister() {},
      },
    },
  });
  const desktop = load("electron/app/desktop-integration.ts", {
    "./install-methods": {
      installMethods: (p: any, m: any) => Object.assign(p, m),
    },
    "./desktop-tray-dock": tray,
    "./quick-access": { quickEntryDictationSupported: () => false },
    "../../shared/settings-extras": preferences,
  });
  const integration = Object.create(desktop.DesktopIntegration.prototype);
  Object.assign(integration, {
    ready: true,
    refreshNotificationSignals() {},
    shortcuts: new Set(),
    options: { settings: () => store.settings },
    updateKeepAwake() {
      calls.push("keepawake");
    },
    updateTray() {
      calls.push("tray");
      if (applyFailure) throw Error("inert tray error");
    },
    accessMonitor: {
      setEnabled() {
        calls.push("monitor");
      },
    },
  });
  const source = fs.readFileSync("electron/app/ipc-register.ts", "utf8");
  const body = source.slice(
    source.indexOf('  handle("saveSettings"'),
    source.indexOf('  handle("windowAction"'),
  );
  const mainState = {
    store,
    engine: {
      stop: async () => {
        throw Error("Unexpected engine call");
      },
      ensure: async () => {
        throw Error("Unexpected engine call");
      },
    },
  };
  vm.runInNewContext(
    ts.transpileModule(body, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    {
      isDeepStrictEqual,
      desktopPreferences,
      saveDeviceDesktopPreferences: () => { throw Error("Unexpected desktop preference change"); },
      localeSaveStage,
      localeSaveFailure,
      handle: (_n: string, fn: any) => (save = fn),
      mainState,
      settingsSchema,
      mergeSavedSettings,
      desktopShortcuts: desktop.desktopShortcuts,
      sendSettings: () => {},
      z,
      structuredClone,
      settingsRefusal,
      policy: () => openPolicy,
      withoutPreferences,
      preference,
      noActive: () => {
        throw Error("Unexpected engine check");
      },
      integration,
      nativeTheme: {},
      settingsListeners: { emit: () => {} },
      deviceLink: { refresh: () => calls.push("device.refresh") },
      rendererSettings: () => store.settings,
      fs,
    },
  );
  const logLines: unknown[][] = [];
  const identity = {},
    ctx: any = {
      log: (...args: unknown[]) => logLines.push(args),
      root: assets,
      account: () => ({ id: "fixture-owner" }),
      settings: () => store.settings,
      sessionIdentity: () => identity,
      isCurrent: () => true,
      localCall: async (method: string, next: any) => {
        assert.equal(method, "saveSettings");
        return save(next);
      },
      call: async () => {
        throw Error("No remote calls");
      },
    };

  assert.equal(
    (await drive(ctx, { ccr_switch_models_on_flag: true })).status,
    200,
  );
  assert.equal(shortcutAttempts, 0);
  assert.equal(calls.length, 0);
  assert.equal(store.settings.switchModelsOnFlag, undefined);
  for (const enabled of [false, true]) {
    calls.length = 0;
    const result = await drive(
      ctx,
      await originalPayload(accountOf(ctx)!.settings),
    );
    assert.equal(result.status, 200);
    assert.equal(shortcutAttempts, 0);
    assert.equal(new Store(dir).settings.switchModelsOnFlag, enabled);
    assert.equal(new Store(dir).settings.modelAutoFallback, false);
    const count = calls.length;
    assert.equal(
      (await drive(ctx, { ccr_switch_models_on_flag: enabled })).status,
      200,
    );
    assert.equal(calls.length, count);
    assert.equal(shortcutAttempts, 0);
    assert.ok(calls.includes("tray"));
    assert.ok(calls.includes("keepawake"));
    assert.ok(calls.includes("monitor"));
  }
  for (const patch of [
    { switchModelsOnFlag: false, quickAccessShortcut: "Control+Shift+Space" },
  ]) {
    await assert.rejects(save({ ...store.settings, ...patch }), (e) =>
      shortcuts.isShortcutRegistrationFailure(e),
    );
    assert.equal(new Store(dir).settings.switchModelsOnFlag, true);
  }
  assert.equal(shortcutAttempts, 2);
  applyFailure = true;
  assert.equal(
    (await drive(ctx, { ccr_switch_models_on_flag: false })).status,
    503,
  );
  assert.equal(store.settings.switchModelsOnFlag, true);
  assert.equal(new Store(dir).settings.switchModelsOnFlag, true);
  assert.equal(shortcutAttempts, 2);
});

import { Readable } from "node:stream";
import { connectorsRoute } from "../../electron/official-ui/api/connectors";
import {
  inAdapterScope,
  newAdapterScope,
} from "../../electron/official-ui/api/scope";
async function drive(ctx: any, body: any) {
  const req: any = Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body))]),
    { method: "PATCH" },
  );
  let status = 0,
    text = "";
  const res: any = {
    writeHead: (s: number) => (status = s),
    end: (s = "") => (text += s),
  };
  await inAdapterScope(
    newAdapterScope(ctx.account().id, ctx.root, ctx.sessionIdentity()),
    () => connectorsRoute(req, res, "/api/account/settings", ctx),
  );
  return { status, body: JSON.parse(text) };
}
async function originalPayload(settings: any) {
  const file = fs.readFileSync(
    path.join(assets, "ui/assets/v1/cb9b4fa24-UI8Csmhy.js"),
    "utf8",
  );
  const start = file.indexOf("var g = [");
  const end = file.indexOf("  v = i((t) =>", start);
  assert.ok(start > 0 && end > start);
  let mutation: any;
  const box: any = {
    i: (fn: any) => fn,
    u: () => ({ account: { settings } }),
    f: () => ({ track() {} }),
    o: () => ({
      mutateAsync: async (body: any) => {
        mutation = body;
      },
    }),
    J9: () => [],
    J4: () => true,
    I4: (...a: any[]) => a[2],
    J8: Symbol(),
    J0: () => true,
    K0: (...a: any[]) => a.at(-1),
    J3: () => true,
    K3: (...a: any[]) => a.at(-1),
    r: (type: any, props: any) => ({ type, props }),
    t: (type: any, props: any) => ({ type, props }),
    n: "fragment",
    d: "message",
    c: "row",
    a: "switch",
    b: () => {},
  };
  vm.runInNewContext(
    file.slice(start, end).replace(/,\s*$/, ";") + ";this.producer=_;",
    box,
  );
  const row = box.producer();
  row.props.control({ labelId: "synthetic" }).props.onCheckedChange();
  await Promise.resolve();
  assert.ok(mutation);
  const source = fs.readFileSync(
    path.join(assets, "ui/assets/v1/shared-l-p-m-w-3-B5uNmf7O.js"),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "official.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let init = "";
  for (const st of ast.statements)
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (d.name.getText(ast) === "FB") init = d.initializer!.getText(ast);
  assert.ok(init);
  const scope: any = {
    bG: () => ({}),
    s4: (url: string, method: string, options: any) => {
      assert.equal(url, "/api/account/settings");
      assert.equal(method, "PATCH");
      return options;
    },
    xE: ["account_settings_patch"],
    VU: () => {},
  };
  const from = source.indexOf("function k7(e) {"),
    to = source.indexOf("var HG =", from);
  vm.runInNewContext(
    source.slice(from, to) + ";this.transport=" + init + ";",
    scope,
  );
  return scope.transport().transformVariables(mutation);
}
test("original remote Code producer plus mutation transform preserve companions; adapter must reject mixed writes", async () => {
  const body = await originalPayload({
    ccr_switch_models_on_flag: true,
    enabled_model_auto_fallback: false,
    enabled_web_search: true,
    tool_search_mode: "off",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(body)), {
    ccr_switch_models_on_flag: false,
    enabled_model_auto_fallback: false,
    enabled_web_search: true,
    tool_search_mode: "off",
  });
  const ctx: any = {
    readOnly: false,
    localCall: () => {
      throw Error("Must not save mixed settings");
    },
    account: () => ({ id: "owner" }),
    sessionIdentity: () => 1,
    isCurrent: () => true,
  };
  assert.equal((await saveOfficialCodeFlaggedSwitch(ctx, body)).status, 400);
});
