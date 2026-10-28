import test from "node:test";
import assert from "node:assert/strict";
import { defaultSettings } from "../../electron/store/store";
import type { DesktopAPI, Settings } from "../../shared/types";
import {
  activateSettingsWriteAccount,
  settingsPatchQueue,
  SettingsPatchQueue,
} from "../../src/settings/settings-patch-queue";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("real account lease cancels unsent settings even when the bridge object is reused", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: { value: Settings; resolve(value: Settings): void }[] = [];
  const bridge = {
    saveSettings(value: Settings) {
      return new Promise<Settings>((resolve) => calls.push({ value, resolve }));
    },
  } as DesktopAPI;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { desktop: bridge },
  });
  let end = activateSettingsWriteAccount("A");
  const oldSaved: Settings[] = [],
    nextSaved: Settings[] = [],
    errors: unknown[] = [];
  try {
    const a = settingsPatchQueue(bridge, defaultSettings, "A");
    const first = a.update(
      { codeDarkTheme: "github-dark" },
      (x) => oldSaved.push(x),
      (e) => errors.push(e),
    );
    const second = a.update(
      { chatFont: "sans" },
      (x) => oldSaved.push(x),
      (e) => errors.push(e),
    );
    assert.equal(calls.length, 1);
    end();
    end = activateSettingsWriteAccount("B");
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    const b = settingsPatchQueue(bridge, defaultSettings, "B");
    assert.notEqual(a, b);
    calls[0].resolve(calls[0].value);
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(oldSaved, []);
    assert.equal(errors.length, 0);
    const next = b.update(
      { chatFont: "serif" },
      (x) => nextSaved.push(x),
      (e) => errors.push(e),
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].value.codeDarkTheme, undefined);
    calls[1].resolve(calls[1].value);
    assert.equal(await next, true);
    assert.equal(nextSaved.length, 1);
  } finally {
    end();
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("queued patches remain optimistic while failure removes only its own unconfirmed choice", async () => {
  const calls: {
    value: Settings;
    resolve(value: Settings): void;
    reject(error: Error): void;
  }[] = [];
  const queue = new SettingsPatchQueue(
    defaultSettings,
    (value) =>
      new Promise((resolve, reject) => calls.push({ value, resolve, reject })),
    () => true,
  );
  const errors: unknown[] = [],
    saved: Settings[] = [],
    views: Settings[] = [];
  const unsubscribe = queue.subscribe((value) => views.push(value));
  const first = queue.update(
    { codeDarkTheme: "github-dark" },
    (x) => saved.push(x),
    (e) => errors.push(e),
  );
  const second = queue.update(
    { codeLightTheme: "github-light" },
    (x) => saved.push(x),
    (e) => errors.push(e),
  );
  assert.equal(calls.length, 1);
  assert.equal(views.at(-1)?.codeDarkTheme, "github-dark");
  assert.equal(views.at(-1)?.codeLightTheme, "github-light");
  calls[0].reject(new Error("head failed"));
  assert.equal(await first, false);
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].value.codeDarkTheme, undefined);
  assert.equal(calls[1].value.codeLightTheme, "github-light");
  assert.equal(views.at(-1)?.codeDarkTheme, undefined);
  calls[1].resolve(calls[1].value);
  assert.equal(await second, true);
  assert.equal(saved.length, 1);
  assert.equal(errors.length, 1);
  unsubscribe();
  queue.cancel();
});
