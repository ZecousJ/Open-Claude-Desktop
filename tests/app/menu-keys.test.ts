import test from "node:test";
import assert from "node:assert/strict";
import {
  SUBMENU_OPEN_DELAY_MS,
  headingForSubmenu,
  insideTriangle,
  stepPosition,
  typeaheadPosition,
} from "../../src/ui/menu-keys";

test("arrows loop round the menu's ends and Home/End jump to them", () => {
  assert.equal(stepPosition("ArrowDown", -1, 4), 0);
  assert.equal(stepPosition("ArrowUp", -1, 4), 3);
  assert.equal(stepPosition("ArrowDown", 3, 4), 0);
  assert.equal(stepPosition("ArrowUp", 0, 4), 3);
  assert.equal(stepPosition("Home", 2, 4), 0);
  assert.equal(stepPosition("End", 1, 4), 3);
  assert.equal(stepPosition("a", 1, 4), undefined);
  assert.equal(stepPosition("ArrowDown", -1, 0), undefined);
});

test("typed letters move to the row they start, and a repeated letter cycles", () => {
  const labels = ["Rename", "Archive", "Add to project", "Delete", "Duplicate"];
  assert.equal(typeaheadPosition(labels, -1, "a"), 1);
  // The same letter again moves on to the next row that starts with it.
  assert.equal(typeaheadPosition(labels, 1, "aa"), 2);
  assert.equal(typeaheadPosition(labels, 2, "aaa"), 1);
  // A longer prefix stays on the row while it still matches, then moves.
  assert.equal(typeaheadPosition(labels, 3, "de"), 3);
  assert.equal(typeaheadPosition(labels, 3, "du"), 4);
  assert.equal(typeaheadPosition(labels, 0, "RE"), 0);
  assert.equal(typeaheadPosition(labels, 0, "x"), -1);
});

test("a pointer heading for an open submenu stays inside its safe triangle", () => {
  assert.equal(SUBMENU_OPEN_DELAY_MS, 100);
  const a = { x: 0, y: 0 },
    b = { x: 10, y: -10 },
    c = { x: 10, y: 10 };
  assert.equal(insideTriangle({ x: 5, y: 0 }, a, b, c), true);
  assert.equal(insideTriangle({ x: 5, y: 8 }, a, b, c), false);
  // The submenu opens to the right of the row the pointer left at (200, 50).
  const submenu = { left: 222, right: 422, top: 40, bottom: 240 };
  const apex = { x: 200, y: 50 };
  assert.equal(headingForSubmenu({ x: 210, y: 70 }, apex, submenu), true);
  assert.equal(headingForSubmenu({ x: 202, y: 90 }, apex, submenu), false);
  // A submenu flipped to the menu's left side uses its right edge.
  const left = { left: 0, right: 180, top: 40, bottom: 240 };
  assert.equal(headingForSubmenu({ x: 190, y: 70 }, apex, left), true);
});
