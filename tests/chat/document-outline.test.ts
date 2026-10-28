import test from "node:test";
import assert from "node:assert/strict";
import {
  activeEntry,
  documentOutline,
  keepInView,
} from "../../src/artifacts/document-outline";

const headings = (levels: number[]) =>
  levels.map((level, i) => ({ level, text: `Heading ${i}` }));

test("the rail lists h1–h3 once there are three of them", () => {
  assert.deepEqual(documentOutline(headings([2, 3])), []);
  // h4 and below never count.
  assert.deepEqual(documentOutline(headings([2, 4, 5, 3])), []);
  const outline = documentOutline(headings([2, 3, 4, 2, 3]));
  assert.deepEqual(
    outline.map((entry) => [entry.index, entry.depth]),
    [
      [0, 0],
      [1, 1],
      [3, 0],
      [4, 1],
    ],
  );
});

test("a lone opening title lifts the rest one level", () => {
  const outline = documentOutline(headings([1, 2, 3, 2, 3]));
  assert.deepEqual(
    outline.map((entry) => entry.depth),
    [0, 0, 1, 0, 1],
  );
  // Two top-level headings: no title, levels count from the top one.
  assert.deepEqual(
    documentOutline(headings([1, 2, 1, 3])).map((entry) => entry.depth),
    [0, 1, 0, 2],
  );
});

test("a long outline keeps every heading on the rail", () => {
  const outline = documentOutline(
    headings(Array.from({ length: 30 }, (_, i) => 1 + (i % 3))),
  );
  assert.equal(outline.length, 30);
  assert.ok(outline.some((entry) => entry.depth === 2));
});

test("the rail scrolls to keep the current tick 40px from its edges", () => {
  const rail = { view: 100, size: 8, buffer: 40 };
  // Already clear of both edges: unchanged.
  assert.equal(keepInView({ ...rail, scrollTop: 0, at: 50 }), 0);
  // Past the bottom edge: just far enough down.
  assert.equal(keepInView({ ...rail, scrollTop: 0, at: 80 }), 28);
  // Above the top edge: up, not past the start.
  assert.equal(keepInView({ ...rail, scrollTop: 60, at: 70 }), 30);
  assert.equal(keepInView({ ...rail, scrollTop: 60, at: 20 }), 0);
});

test("the heading being read is the last above a line 20% down", () => {
  const outline = documentOutline(headings([1, 2, 2]));
  const view = { scrollTop: 100, clientHeight: 500, scrollHeight: 2000 };
  assert.equal(activeEntry(outline, [-300, 50, 400], view)?.index, 1);
  assert.equal(
    activeEntry(outline, [-300, 50, 400], { ...view, scrollTop: 0 })?.index,
    0,
  );
  assert.equal(
    activeEntry(outline, [-300, 50, 400], { ...view, scrollTop: 1500 })?.index,
    2,
  );
});
