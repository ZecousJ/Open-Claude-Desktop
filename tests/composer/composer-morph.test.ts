import test from "node:test";
import assert from "node:assert/strict";
import {
  needsTwoRows,
  singleLineReserve,
} from "../../src/composer/useComposerMorph";

test("an empty draft keeps the single row", () => {
  assert.equal(needsTwoRows("", 0, 400), false);
});

test("a line break always takes two rows", () => {
  assert.equal(needsTwoRows("a\nb", 10, 400), true);
});

test("the row turns before the text reaches the actions", () => {
  const room = 400;
  assert.equal(needsTwoRows("x", room - singleLineReserve, room), false);
  assert.equal(needsTwoRows("x", room - singleLineReserve + 1, room), true);
});

test("the same test brings the single row back once the text fits", () => {
  // Measured against the single row's room whatever the current form.
  assert.equal(needsTwoRows("short", 120, 400), false);
});
