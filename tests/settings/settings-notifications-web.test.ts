import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { JSDOM } from "jsdom";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";

const { NotificationsSection } =
  await import("../../src/settings/tabs/General");
const { defaultSettings } = await import("../../electron/store/store");

test("the web Scheduled tasks switch asks the browser first and stays off when it is refused", async () => {
  const dom = new JSDOM("<html><body><main></main></body></html>", {
    url: "https://app.test",
  });
  const { window } = dom;
  Object.defineProperty(window, "isSecureContext", { value: true });
  let asked = 0;
  const notification = {
    permission: "default",
    requestPermission: async () => (++asked === 1 ? "denied" : "granted"),
  };
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Notification: notification,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const changes: unknown[] = [];
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.querySelector("main")!);
  try {
    await act(async () =>
      root.render(
        createElement(NotificationsSection, {
          settings: { ...defaultSettings, notifySchedules: false },
          save: (patch: unknown) => {
            changes.push(patch);
          },
        }),
      ),
    );
    const control = window.document.querySelector<HTMLButtonElement>(
      '[aria-label="Scheduled tasks"]',
    )!;
    await act(async () => control.click());
    assert.equal(asked, 1);
    assert.equal(changes.length, 0);
    assert.equal(control.getAttribute("aria-checked"), "false");
    await act(async () => control.click());
    assert.equal(asked, 2);
    assert.equal(changes.length, 1);
    assert.equal(
      (changes[0] as { notifySchedules: boolean }).notifySchedules,
      true,
    );
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
