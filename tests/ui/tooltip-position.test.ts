import test from "node:test";
import assert from "node:assert/strict";
import { tooltipPosition, tooltipSide } from "../../src/ui/tooltip-position";

const view = { width: 1000, height: 700 };
const size = { width: 80, height: 24 };

test("a tooltip above a button at the window's top opens below it", () => {
  const box = { left: 100, top: 10, right: 124, bottom: 34 };
  const at = tooltipPosition(box, size, view, "above");
  assert.equal(tooltipSide(box, size, view, "above"), "below");
  assert.equal(at.top, 34 + 4);
});

test("a tooltip below a button at the window's bottom opens above it", () => {
  const box = { left: 100, top: 660, right: 124, bottom: 690 };
  const at = tooltipPosition(box, size, view, "below");
  assert.equal(tooltipSide(box, size, view, "below"), "above");
  assert.equal(at.top, 660 - 4 - 24);
});

test("a tooltip beside a button at the right edge opens on its left", () => {
  const box = { left: 960, top: 100, right: 990, bottom: 124 };
  const at = tooltipPosition(box, size, view, "right");
  assert.equal(tooltipSide(box, size, view, "right"), "left");
  assert.equal(at.left, 960 - 4 - 4 - 80);
});

test("a tooltip that fits keeps its side", () => {
  const box = { left: 400, top: 300, right: 424, bottom: 324 };
  const at = tooltipPosition(box, size, view, "above");
  assert.equal(tooltipSide(box, size, view, "above"), "above");
  assert.equal(at.top, 300 - 4 - 24);
});

test("with no room on either side it stays and is kept in the window", () => {
  const box = { left: 100, top: 0, right: 124, bottom: 24 };
  const tall = { width: 80, height: 700 };
  const at = tooltipPosition(box, tall, view, "above");
  assert.equal(tooltipSide(box, tall, view, "above"), "above");
  assert.ok(at.top >= 8);
});
