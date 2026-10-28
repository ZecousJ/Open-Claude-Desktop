import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { Toaster } from "../../src/ui/Toaster";
import { dismissAllToasts, showToast } from "../../src/ui/toast-store";

test("a toast's button sits under its text, and a fourth toast waits hidden", () => {
  dismissAllToasts();
  showToast("Copied");
  showToast("Saved");
  showToast("Exported");
  showToast("Unpinned", { action: { label: "Undo", onSelect() {} } });
  const { document } = parseHTML(renderToStaticMarkup(createElement(Toaster)));
  const toasts = [...document.querySelectorAll(".toast")];
  assert.equal(toasts.length, 4);
  // Newest first: the Undo toast is in front and shows.
  const front = toasts[0];
  assert.equal(front.textContent?.includes("Unpinned"), true);
  assert.ok(front.querySelector(".toast-text > .toast-action"));
  assert.equal(front.getAttribute("data-limited"), null);
  // The oldest is the fourth: kept, hidden, inert.
  const waiting = toasts[3];
  assert.equal(waiting.getAttribute("data-limited"), "true");
  assert.equal(waiting.getAttribute("aria-hidden"), "true");
  assert.ok(waiting.hasAttribute("inert"));
  dismissAllToasts();
});
