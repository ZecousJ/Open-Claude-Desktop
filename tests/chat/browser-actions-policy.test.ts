import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement, act } from "react";
import { parseHTML } from "linkedom";
import { BrowserActionsDialog } from "../../src/settings/tabs/BrowserActionsDialog";
import { tierLabels } from "../../src/computer-use/labels";

test("access tiers retain the official labels and accent/neutral badge colors", () => {
  assert.deepEqual(tierLabels, {
    read: "View only",
    click: "Click only",
    full: "All",
  });
  const css = readFileSync(
    new URL("../../src/computer-use/computer-use.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.cu-tier \{[^}]*background: rgb\(0 36 81 \/ 75%\);[^}]*color: #6da7ec;/,
  );
  assert.match(
    css,
    /\.cu-tier\[data-tier="full"\] \{[^}]*background: rgb\(255 255 255 \/ 5%\);[^}]*color: var\(--text-secondary\);/,
  );
  assert.match(
    css,
    /data-theme="light"\] \.cu-tier \{[^}]*background: rgb\(118 178 251 \/ 35%\);[^}]*color: #184f95;/,
  );
  assert.match(
    css,
    /data-theme="light"\] \.cu-tier\[data-tier="full"\] \{[^}]*background: rgb\(11 11 11 \/ 5%\);[^}]*color: #52514e;/,
  );
});

test("allow-all warning starts on Cancel and never enables actions without Allow", async () => {
  const { window } = parseHTML(
    '<html data-motion="reduced"><body><main></main></body></html>',
  );
  const values = {
    window,
    document: window.document,
    navigator: { userAgent: "node" },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.querySelector("main")!);
  let cancelled = 0;
  let allowed = 0;
  try {
    await act(async () =>
      root.render(
        createElement(BrowserActionsDialog, {
          onClose: () => cancelled++,
          onAllow: () => allowed++,
        }),
      ),
    );
    const dialog = window.document.querySelector('[role="alertdialog"]')!;
    assert.equal(
      dialog.getAttribute("aria-label"),
      "Allow all browser actions?",
    );
    assert.match(
      dialog.textContent!,
      /including on websites you haven’t approved/,
    );
    assert.equal(
      dialog.querySelector("[data-initial-focus]")?.textContent,
      "Cancel",
    );
    assert.equal(
      dialog.querySelector("a")?.getAttribute("rel"),
      "noopener noreferrer",
    );
    assert.equal(allowed, 0);
    await act(async () =>
      dialog.querySelector<HTMLButtonElement>(".secondary")!.click(),
    );
    assert.equal(cancelled, 1);
    assert.equal(allowed, 0);
    const escape = new window.Event("keydown", { bubbles: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    await act(async () => window.document.dispatchEvent(escape));
    assert.equal(cancelled, 2);
    assert.equal(allowed, 0);
    await act(async () =>
      dialog.querySelector<HTMLButtonElement>(".primary")!.click(),
    );
    assert.equal(allowed, 1);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
