import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RESIZE_STEP_LARGE_PX,
  RESIZE_STEP_PX,
  ResizeHandle,
  resizeStep,
} from "../../src/ui/ResizeHandle";

test("a divider moves 8px per arrow, 32px with Shift, along its own axis", () => {
  assert.equal(RESIZE_STEP_PX, 8);
  assert.equal(RESIZE_STEP_LARGE_PX, 32);
  assert.equal(resizeStep("ArrowLeft", false), -8);
  assert.equal(resizeStep("ArrowRight", true), 32);
  assert.equal(resizeStep("ArrowUp", false), undefined);
  assert.equal(resizeStep("ArrowDown", true, "horizontal"), 32);
  assert.equal(resizeStep("ArrowLeft", false, "horizontal"), undefined);
});

test("a divider is a focusable separator with the centred pill", () => {
  const html = renderToStaticMarkup(
    createElement(ResizeHandle, {
      label: "Resize file viewer",
      className: "file-viewer-resize",
      dragging: true,
      "aria-valuenow": 50,
      onStep() {},
    }),
  );
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /class="resize-handle file-viewer-resize"/);
  assert.match(html, /data-dragging="true"/);
  assert.match(html, /<span class="resize-handle-pill" aria-hidden="true">/);
});
