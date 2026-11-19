import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPreferences } from "../electron/official-ui/native/preferences";
import { setStateDir } from "../electron/official-ui/api/state";
import { browserToolsOn } from "../electron/browser/browser-tools-registration";
import type { SettingsPreferences } from "../shared/settings-extras";
import { preferenceFields } from "../shared/settings-extras-schema";

test("official startup reads the OS state and applies only explicit boolean changes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-startup-preferences-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  setStateDir(root);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let runOnStartup: boolean | null = false;
  let allowChanges = true;
  const writeError = new Error("Unable to change the login item.");
  const call = t.mock.fn(async (method: string, value?: unknown) => {
    if (method === "setRunOnStartup") {
      if (runOnStartup === null) throw writeError;
      if (allowChanges && typeof value === "boolean") runOnStartup = value;
    } else {
      assert.equal(method, "systemState");
    }
    return { runOnStartup };
  });
  const host = {
    ctx: { call, account: () => undefined, onEvent: () => () => {} },
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, handler);
      return host;
    },
  };
  registerPreferences(host as unknown as Parameters<typeof registerPreferences>[0], {});
  const read = handlers.get("Startup.isStartupOnLoginEnabled")!;
  const write = handlers.get("Startup.setStartupOnLoginEnabled")!;
  assert.equal(call.mock.callCount(), 0);
  assert.equal(await read(), false);

  for (const enabled of [true, false]) {
    assert.equal(await write(enabled), undefined);
    assert.equal(await read(), enabled);
  }
  const calls = call.mock.callCount();
  await assert.rejects(async () => write("false"));
  assert.equal(call.mock.callCount(), calls);

  allowChanges = false;
  await assert.rejects(async () => write(true), /startup settings/);
  assert.equal(await read(), false);

  runOnStartup = null;
  await assert.rejects(async () => read(), /unavailable/);
  await assert.rejects(async () => write(true), writeError);
});

test("the background computer-use introduction defaults to unseen for each account", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-computer-intro-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let owner = "first";
  const handlers = new Map<string, any>();
  const host: any = {
    ctx: {
      account: () => ({ id: owner }),
      settings: () => ({}),
      stateDirectory: () => root,
      onEvent: () => () => {},
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
      return host;
    },
    emit() {},
  };
  registerPreferences(host, {});
  const seen = () => handlers.get("AppPreferences.getPreferences")().chicagoBackgroundIntroSeen;
  const setSeen = (value: unknown) =>
    handlers.get("AppPreferences.setPreference")("chicagoBackgroundIntroSeen", value);
  assert.equal(seen(), false);
  await assert.rejects(setSeen("true"));
  await setSeen(true);
  registerPreferences(host, {});
  assert.equal(seen(), true);
  owner = "second";
  assert.equal(seen(), false);
});

test("official preview preference supplies its supported default and preserves an explicit off choice", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-launch-preferences-"),
  );
  setStateDir(root);
  try {
    const handlers = new Map<string, any>();
    let settings: SettingsPreferences = {};
    const chosenFolder = path.join(root, "selected");
    const host: any = {
      caller: {},
      hasFolderSelection(_caller: object, folder: string) {
        return folder === chosenFolder;
      },
      ctx: {
        account: () => ({ id: "fixture" }),
        settings: () => settings,
        async call(method: string, next: typeof settings) {
          assert.equal(method, "saveSettings");
          settings = next;
        },
        onEvent: () => () => {},
      },
      on(n: string, f: any) {
        handlers.set(n, f);
        return host;
      },
      emit() {},
    };
    registerPreferences(host, { launch: { status: "supported" } });
    assert.deepEqual(handlers.get("AppPreferences.getPreferences")().bypassPermissionsOptInByAccount, { fixture: true });
    const bypassGate = () =>
      handlers.get("AppPreferences.getPreferences")().bypassPermissionsGateByAccount;
    const cacheBypass = (entries: Record<string, boolean>) =>
      handlers.get("AppPreferences.setPreference")("bypassPermissionsGateByAccount", entries);
    assert.deepEqual(bypassGate(), {});
    await cacheBypass({ fixture: true });
    assert.deepEqual(bypassGate(), { fixture: true });
    await assert.rejects(cacheBypass({ fixture: true, other: true }), /active account/);
    await assert.rejects(
      handlers.get("AppPreferences.setPreference")("bypassPermissionsOptInByAccount", { other: true }),
      /active account/,
    );
    await handlers.get("AppPreferences.setPreference")("bypassPermissionsOptInByAccount", { fixture: false });
    assert.equal(settings.allowBypassPermissions, false);
    assert.deepEqual(handlers.get("AppPreferences.getPreferences")().bypassPermissionsOptInByAccount, { fixture: false });
    await cacheBypass({ fixture: true });
    assert.equal(settings.allowBypassPermissions, false);
    assert.deepEqual(bypassGate(), { fixture: false });
    assert.equal(handlers.get("AppPreferences.getPreferences")().chillingSlothLocation, "default");
    await assert.rejects(handlers.get("AppPreferences.setPreference")("chillingSlothLocation", { customPath: path.join(root, "unselected") }), /folder picker/);
    await handlers.get("AppPreferences.setPreference")("chillingSlothLocation", { customPath: chosenFolder });
    assert.equal(settings.codeWorktreeLocation, chosenFolder);
    assert.deepEqual(handlers.get("AppPreferences.getPreferences")().chillingSlothLocation, { customPath: chosenFolder });
    await handlers.get("AppPreferences.setPreference")("chillingSlothLocation", "default");
    assert.equal(settings.codeWorktreeLocation, "");
    assert.equal(
      handlers.get("AppPreferences.getPreferences")().launchEnabled,
      true,
    );
    await handlers.get("AppPreferences.setPreference")("coworkBrowserToolsEnabled", false);
    assert.equal(browserToolsOn(settings, {}, "code"), true);
    assert.equal(browserToolsOn(settings, {}, "cowork"), false);
    for (const [original, stored] of [["shared", "always"], ["session", "per-session"], ["none", "until-quit"]]) {
      await handlers.get("AppPreferences.setPreference")("launchPreviewStorage", original);
      assert.equal(settings.browserKeepCookies, stored);
      assert.equal(handlers.get("AppPreferences.getPreferences")().launchPreviewStorage, original);
    }
    await handlers.get("AppPreferences.setPreference")("coworkBrowserToolsEnabled", true);
    await handlers.get("AppPreferences.setPreference")("launchEnabled", false);
    assert.equal(
      handlers.get("AppPreferences.getPreferences")().launchEnabled,
      false,
    );
    assert.equal(browserToolsOn(settings, {}, "code"), false);
    assert.equal(browserToolsOn(settings, {}, "cowork"), true);
    registerPreferences(host, { launch: { status: "supported" } });
    assert.equal(
      handlers.get("AppPreferences.getPreferences")().launchEnabled,
      false,
    );
    await handlers.get("AppPreferences.setPreference")("launchEnabled", true);
    await handlers.get("AppPreferences.setPreference")("coworkBrowserToolsEnabled", false);
    assert.equal(browserToolsOn(settings, {}, "code"), true);
    assert.equal(browserToolsOn(settings, {}, "cowork"), false);
    assert.equal(browserToolsOn(settings, { browser: { enabled: false, externalSites: true, allowScript: true, devServers: true, blockedDomains: [] } }, "code"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("official preferences round-trip voice and in-chat shortcut choices across a reload", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-dictation-preferences-"));
  setStateDir(root);
  try {
    let settings: SettingsPreferences = {};
    const handlers = new Map<string, any>();
    const host: any = {
      ctx: {
        account: () => ({ id: "fixture" }),
        settings: () => settings,
        async call(method: string, next: SettingsPreferences) {
          assert.equal(method, "saveSettings");
          preferenceFields.dictationShortcut.parse(next.dictationShortcut);
          preferenceFields.quickEntryDictationShortcut.parse(next.quickEntryDictationShortcut);
          settings = structuredClone(next);
        },
        onEvent: () => () => {},
      },
      on(n: string, f: any) { handlers.set(n, f); return host; },
      emit() {},
    };
    registerPreferences(host, {});
    for (const [key, values] of Object.entries({
      quickEntryDictationShortcut: ["capslock", "double-tap-capslock", { accelerator: "Cmd+Shift+Alt+Space" }, { accelerator: "" }, "off"],
      dictationShortcut: ["off", { accelerator: "" }, { accelerator: "Ctrl+D" }, { accelerator: "CommandOrControl+D" }, { accelerator: "F24" }, "default"],
    })) {
      for (const value of values) {
        await handlers.get("AppPreferences.setPreference")(key, value);
        registerPreferences(host, {});
        assert.deepEqual(handlers.get("AppPreferences.getPreferences")()[key], value);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Chrome extension setup uses only host-owned operations", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-chrome-setup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let enabled = false;
  let reveals = 0;
  const status = () => ({ enabled, connected: false, bundlePath: "/fixed/extension" });
  const handlers = new Map<string, any>();
  const host: any = {
    ctx: {
      account: () => ({ id: "fixture" }),
      settings: () => ({}),
      stateDirectory: () => root,
      onEvent: () => () => {},
      chromeExtension: {
        status,
        async configure(value: boolean) { enabled = value; return status(); },
        async revealBundle() { reveals++; },
      },
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
      return host;
    },
    emit() {},
  };
  registerPreferences(host, {});
  const read = () => handlers.get("AppPreferences.getPreferences")().claudexChromeExtension;
  const write = (key: string, value: unknown) => handlers.get("AppPreferences.setPreference")(key, value);
  assert.deepEqual(read(), status());
  await assert.rejects(write("claudexChromeExtensionEnabled", "true"));
  await assert.rejects(write("claudexChromeExtension", { enabled: true }));
  await assert.rejects(write("claudexChromeExtensionReveal", "/other/path"));
  assert.equal(reveals, 0);
  await write("claudexChromeExtensionEnabled", true);
  assert.equal(read().enabled, true);
  await write("claudexChromeExtensionReveal", true);
  assert.equal(reveals, 1);
  await write("claudexChromeExtensionEnabled", false);
  assert.equal(read().enabled, false);
});
