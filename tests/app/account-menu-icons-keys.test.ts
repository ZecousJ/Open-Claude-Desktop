import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { AppController } from "../../src/app/AppContext";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const { AccountMenu } = await import("../../src/sidebar/AccountMenu");
const { AppContext } = await import("../../src/app/AppContext");

test("the account menu draws the icon font's glyphs, marks external links, and takes arrow keys", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  Object.assign(window, { innerHeight: 900 });
  // linkedom has no focus model: record the focused element.
  let focused: Element | null = null;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused,
  });
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
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
  const root = createRoot(document.querySelector("main")!);
  const key = (element: Element, name: string) =>
    act(async () => {
      const event = new window.Event("keydown", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(event, { key: name });
      element.dispatchEvent(event);
    });
  try {
    await act(async () =>
      root.render(
        createElement(
          AppContext.Provider,
          { value: { setShortcutsOpen() {} } as unknown as AppController },
          createElement(AccountMenu, {
            name: "Fixture",
            email: "fixture@example.invalid",
            mode: "chat",
            onSettings() {},
            onUsage() {},
            onChangelog() {},
            onSignOut: async () => {},
            onError(error: unknown) {
              throw error;
            },
          }),
        ),
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(".profile")!;
    // The footer's arrow is CaretDown at the xs size.
    assert.ok(trigger.querySelector('[data-icon="CaretDown"]'));
    trigger.focus();
    await key(trigger, "ArrowDown");
    const menu = document.querySelector('.profile-popover[role="menu"]')!;
    const rows = () => [
      ...menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ];
    const iconOf = (label: string) =>
      rows()
        .find((row) =>
          [...row.querySelectorAll("span")].some(
            (span) => span.textContent === label,
          ),
        )
        ?.querySelector("[data-icon]")
        ?.getAttribute("data-icon");
    assert.equal(iconOf("Settings"), "Settings");
    assert.equal(iconOf("Usage"), "UsageGaugeMiddle");
    assert.equal(iconOf("Language"), "Globe");
    assert.equal(iconOf("Get help"), "Help");
    assert.equal(iconOf("Learn more"), "Info");
    assert.equal(iconOf("Get API keys"), "Key");
    assert.equal(iconOf("Log out"), "Logout");
    // Get help is an external link; Settings is not.
    const help = rows().find((row) => row.textContent?.includes("Get help"))!;
    assert.ok(help.querySelector('[data-icon="ArrowOutSquare"]'));
    assert.equal(rows()[0].querySelector('[data-icon="ArrowOutSquare"]'), null);
    // ↓ opened onto the first row; ↑ ↓ Home End walk and loop.
    assert.ok(document.activeElement === rows()[0]);
    await key(rows()[0], "ArrowUp");
    assert.ok(document.activeElement === rows().at(-1));
    await key(rows().at(-1)!, "ArrowDown");
    assert.ok(document.activeElement === rows()[0]);
    await key(rows()[0], "ArrowDown");
    assert.ok(document.activeElement === rows()[1]);
    await key(rows()[1], "End");
    assert.ok(document.activeElement === rows().at(-1));
    // Escape closes and focus goes back to the account button.
    await key(rows().at(-1)!, "Escape");
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.ok(document.activeElement === trigger);
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
});
