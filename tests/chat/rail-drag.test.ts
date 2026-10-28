import assert from "node:assert/strict";
import test from "node:test";
import {
  railDragFrame,
  railDropBefore,
} from "../../src/session-rail/rail-drag";

// Three cards 10px apart: 0..40, 50..150, 160..200.
const boxes = [
  { top: 0, height: 40 },
  { top: 50, height: 100 },
  { top: 160, height: 40 },
];

test("a rail card dragged down opens its place by its height and the gap", () => {
  const frame = railDragFrame(boxes, 0, 170);
  assert.equal(frame.target, 2);
  assert.deepEqual(frame.shifts, [0, -50, -50]);
  assert.equal(railDropBefore(["a", "b", "c"], 0, frame.target), null);
});

test("a rail card dragged up pushes the cards it passes down", () => {
  const frame = railDragFrame(boxes, 2, -90);
  assert.equal(frame.target, 1);
  assert.deepEqual(frame.shifts, [0, 50, 0]);
  assert.equal(railDropBefore(["a", "b", "c"], 2, frame.target), "b");
});

test("a short drag keeps the order", () => {
  const frame = railDragFrame(boxes, 1, 12);
  assert.equal(frame.target, 1);
  assert.deepEqual(frame.shifts, [0, 0, 0]);
  assert.equal(railDropBefore(["a", "b", "c"], 1, frame.target), undefined);
});
