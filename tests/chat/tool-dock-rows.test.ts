import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_ROW_PX,
  moveRowDivider,
  rowVariable,
} from "../../src/app/tool-dock-rows";

test("a row divider moves height between its two cards only", () => {
  assert.deepEqual(moveRowDivider([200, 400, 300], 1, 50), [200, 450, 250]);
  assert.deepEqual(moveRowDivider([200, 400, 300], 0, -30), [170, 430, 300]);
});

test("neither card gets shorter than the floor", () => {
  assert.equal(MIN_ROW_PX, 120);
  assert.deepEqual(moveRowDivider([300, 300], 0, 900), [480, 120]);
  assert.deepEqual(moveRowDivider([300, 300], 0, -900), [120, 480]);
  // Two short cards split what they have.
  assert.deepEqual(moveRowDivider([100, 100], 0, 60), [100, 100]);
  assert.deepEqual(moveRowDivider([300], 0, 10), [300]);
  assert.equal(rowVariable("changes"), "--tool-row-changes");
});
