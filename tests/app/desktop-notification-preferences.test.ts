import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { settingsRefusal, openPolicy } from "../../shared/client-policy";
import type { NotificationLevels } from "../../shared/notification-levels";
import { preference } from "../../shared/settings-extras";
import type { Settings } from "../../shared/types";
import {
  desktopPreferences,
  readDesktopPreferences,
  writeDesktopPreferences,
} from "../../electron/store/desktop-preferences";
import { mergeSavedSettings } from "../../electron/store/settings-merge";
import { withoutPreferences } from "../../electron/store/settings-preferences";
import {
  publicSettingsOf,
  settingsSchema,
} from "../../electron/store/settings-schema";
import { Store } from "../../electron/store/store";

test("notification preference saves reach other windows and roll back on a device write failure", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-notification-preferences-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, "profile"));
  store.settings.notifyResponses = true;
  store.flush();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: { type: string; settings: Settings }[] = [];
  const noop = () => {};
  const source = fs.readFileSync(
    new URL("../../electron/app/ipc-register.ts", import.meta.url),
    "utf8",
  );
  const mocks: Record<string, Record<string, unknown>> = {};
  for (const [, names, specifier] of source.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    if (specifier === "zod" || specifier.startsWith("node:")) continue;
    mocks[specifier] = Object.fromEntries(
      names
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => [name, noop]),
    );
  }
  Object.assign(mocks.electron, { nativeTheme: {} });
  Object.assign(mocks["./main-state"], { mainState: { store } });
  Object.assign(mocks["./ipc-handle"], { handle: handlers.set.bind(handlers) });
  Object.assign(mocks["../store/desktop-preferences"], { desktopPreferences });
  Object.assign(mocks["../store/settings-merge"], { mergeSavedSettings });
  Object.assign(mocks["../store/settings-preferences"], { withoutPreferences });
  Object.assign(mocks["../store/settings-schema"], { settingsSchema });
  Object.assign(mocks["../../shared/client-policy"], { settingsRefusal });
  Object.assign(mocks["../../shared/settings-extras"], { preference });
  Object.assign(mocks["../main"], {
    nativeExtensions: { register: noop },
    policy: () => openPolicy,
    integration: { apply: noop },
    settingsListeners: { emit: noop },
    deviceLink: { refresh: noop },
    push: (event: (typeof events)[number]) => events.push(event),
    rendererSettings: () => publicSettingsOf(store.settings),
    noActive: () =>
      assert.fail(
        "Notification preferences must save while the agent is busy.",
      ),
    saveDeviceDesktopPreferences: (
      value: Parameters<typeof writeDesktopPreferences>[1],
    ) => writeDesktopPreferences(root, value),
  });
  const registry = Object.assign(globalThis, {
    desktopNotificationPreferenceMocks: mocks,
  });
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (
        context.parentURL?.endsWith("/electron/app/ipc-register.ts") &&
        mocks[specifier]
      ) {
        const exports = Object.keys(mocks[specifier])
          .map((name) => `export const ${name}=m.${name};`)
          .join("");
        const module = `const m=globalThis.desktopNotificationPreferenceMocks[${JSON.stringify(specifier)}];${exports}`;
        return {
          shortCircuit: true,
          url: "data:text/javascript," + encodeURIComponent(module),
        };
      }
      return next(specifier, context);
    },
  });
  t.after(() => {
    hooks.deregister();
    Reflect.deleteProperty(registry, "desktopNotificationPreferenceMocks");
  });
  const { register } = await import("../../electron/app/ipc-register");
  register();
  const save = handlers.get("saveSettings");
  assert.ok(save);

  const levels = {
    idle: "badge",
    permission: "off",
  } satisfies NotificationLevels;
  await save({ ...store.settings, notificationLevels: levels });
  await save({ ...store.settings, notificationSound: "none" });
  await save({ ...store.settings, drawAttention: true });
  assert.deepEqual(readDesktopPreferences(root), {
    notificationLevels: levels,
    notificationSound: "none",
    drawAttention: true,
  });
  assert.deepEqual(
    events.map(({ type, settings }) => [
      type,
      settings.notificationLevels,
      settings.notificationSound,
      settings.drawAttention,
    ]),
    [
      ["settings", levels, undefined, undefined],
      ["settings", levels, "none", undefined],
      ["settings", levels, "none", true],
    ],
  );
  assert.equal(new Store(store.root).settings.notifyResponses, true);

  await save({
    ...store.settings,
    notifyResponses: false,
    notificationLevels: undefined,
    notificationSound: undefined,
    drawAttention: undefined,
  });
  assert.equal(new Store(store.root).settings.notifyResponses, false);
  assert.deepEqual(readDesktopPreferences(root), {
    notificationLevels: levels,
    notificationSound: "none",
    drawAttention: true,
  });

  fs.mkdirSync(path.join(root, "desktop-keybindings.json.tmp"));
  await assert.rejects(
    async () => save({ ...store.settings, notificationLevels: {} }),
    /desktop-keybindings\.json\.tmp/,
  );
  assert.deepEqual(readDesktopPreferences(root)?.notificationLevels, levels);
  assert.deepEqual(new Store(store.root).settings.notificationLevels, levels);
  assert.deepEqual(store.settings.notificationLevels, levels);
  assert.equal(events.length, 3);
});
