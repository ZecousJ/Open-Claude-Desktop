import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { AppController } from "../../src/app/AppContext";
import { readSource } from "../support/read-source";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const { AccountMenu } = await import("../../src/sidebar/AccountMenu");
const { AppContext } = await import("../../src/app/AppContext");

test("#40 desktop-width web peek uses the published popover surface without changing docked, native or phone selectors", () => {
  const css = readSource(
    new URL("../../src/sidebar/sidebar.css", import.meta.url),
    "utf8",
  );
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, selector);
    return { start, body: css.slice(start, css.indexOf("}", start) + 1) };
  };
  const dark = block(".app.web.sidebar-hidden .sidebar[data-peek]");
  const light = block(
    ':root[data-theme="light"] .app.web.sidebar-hidden .sidebar[data-peek]',
  );
  assert.ok(
    css.slice(0, dark.start).trimEnd().endsWith("@media (min-width: 640px) {"),
  );
  assert.match(dark.body, /background: #20201f;/);
  assert.match(
    dark.body,
    /border-right: 0\.5px solid rgb\(255 255 255 \/ 10%\);/,
  );
  assert.match(light.body, /background: #fff;/);
  assert.match(light.body, /border-right-color: rgb\(11 11 11 \/ 10%\);/);
  assert.match(block(".sidebar").body, /background: var\(--sidebar\);/);
  assert.doesNotMatch(dark.body, /\.app:not\(\.web\)|max-width: 639/);
});

test("#35 Learn more keyboard dismissal returns to its parent and Keyboard shortcuts opens the real action", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  Object.assign(window, { innerHeight: 900 });
  const globals = {
    window,
    document,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout,
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
  const prototype = window.HTMLElement.prototype;
  const originalHeight = Object.getOwnPropertyDescriptor(
    prototype,
    "offsetHeight",
  );
  Object.defineProperty(prototype, "offsetHeight", {
    configurable: true,
    get: () => 200,
  });
  const opened: SetStateAction<boolean>[] = [];
  const app = {
    setShortcutsOpen: (value: SetStateAction<boolean>) => {
      opened.push(value);
    },
  } as AppController;
  const root = createRoot(document.querySelector("main")!);
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(
        new window.Event("click", { bubbles: true, cancelable: true }),
      );
    });
  };
  const key = async (element: Element, key: string) => {
    const event = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(event, { key });
    await act(async () => {
      element.dispatchEvent(event);
    });
  };
  const main = () =>
    document.querySelector(
      '.profile-popover:not(.profile-submenu)[role="menu"]',
    );
  const submenu = () => document.querySelector('.profile-submenu[role="menu"]');
  try {
    await act(async () =>
      root.render(
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(AccountMenu, {
            name: "Fixture",
            email: "fixture@example.invalid",
            mode: "chat",
            onSettings() {},
            onUsage() {},
            onChangelog() {},
            onError(error: unknown) {
              throw error;
            },
          }),
        ),
      ),
    );
    await click(document.querySelector(".profile")!);
    const learn = [
      ...main()!.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (button) =>
        button.querySelector("span:not([data-icon])")?.textContent ===
        "Learn more",
    )!;
    let focusReturns = 0;
    learn.focus = () => {
      focusReturns++;
    };
    for (const closeKey of ["Escape", "ArrowLeft"]) {
      await click(learn);
      assert.ok(submenu());
      await key(submenu()!.querySelector("button")!, closeKey);
      assert.ok(main(), "dismissing a submenu leaves its parent menu open");
      assert.equal(submenu(), null);
      assert.equal(learn.getAttribute("aria-expanded"), "false");
    }
    assert.equal(focusReturns, 2);
    await key(learn, "ArrowRight");
    assert.ok(submenu());
    const shortcuts = [
      ...submenu()!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Keyboard shortcuts")!;
    assert.ok(shortcuts);
    await click(shortcuts);
    assert.deepEqual(opened, [true]);
    assert.equal(main(), null);
    assert.equal(submenu(), null);
  } finally {
    await act(async () => root.unmount());
    if (originalHeight)
      Object.defineProperty(prototype, "offsetHeight", originalHeight);
    else Reflect.deleteProperty(prototype, "offsetHeight");
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
