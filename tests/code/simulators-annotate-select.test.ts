import test from "node:test";
import assert from "node:assert/strict";
import {
  arrowHead,
  bentArrowHead,
  commit,
  emptyHistory,
  historyLimit,
  moveMark,
  removeMark,
  replaceMark,
  revealProgress,
  textMeasurer,
  type LineMark,
  type Mark,
  type TextMark,
} from "../../src/simulators/annotate-sketch";
import {
  bendHandle,
  bendThrough,
} from "../../src/simulators/annotate-geometry";
import {
  clampMove,
  constrainPoint,
  dragHandle,
  handleAt,
  markAt,
  markContains,
  markHandles,
  resizeText,
  targetRedaction,
  textTargetAt,
} from "../../src/simulators/annotate-hit";
import { findTextBoxes } from "../../src/simulators/annotate-text-targets";

const measure = textMeasurer(null);
const options = { scale: 1, measure };

const rect = (x1: number, y1: number, x2: number, y2: number): Mark => ({
  kind: "rect",
  color: "#E03131",
  width: 4,
  from: { x: x1, y: y1 },
  to: { x: x2, y: y2 },
});
const line = (x2: number, y2: number): LineMark => ({
  kind: "line",
  color: "#E03131",
  width: 4,
  from: { x: 0, y: 0 },
  to: { x: x2, y: y2 },
});
const label = (text: string): TextMark => ({
  kind: "text",
  color: "#1971C2",
  size: 16,
  at: { x: 100, y: 100 },
  text,
});

test("select: outlines pick a shape up, its inside doesn't; pen strokes never", () => {
  const box = rect(10, 10, 110, 110);
  assert.equal(markContains(box, { x: 12, y: 60 }, options), true);
  assert.equal(markContains(box, { x: 60, y: 60 }, options), false);
  assert.equal(
    markContains(box, { x: 60, y: 60 }, { ...options, coarse: true }),
    false,
  );
  const redaction: Mark = {
    kind: "redact",
    style: "solid",
    from: { x: 10, y: 10 },
    to: { x: 50, y: 30 },
  };
  assert.equal(markContains(redaction, { x: 30, y: 20 }, options), true);
  const pen: Mark = {
    kind: "pen",
    color: "#E03131",
    width: 4,
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
  };
  assert.equal(markContains(pen, { x: 5, y: 0 }, options), false);
  const words = label("hello");
  assert.equal(markContains(words, { x: 105, y: 105 }, options), true);
  assert.equal(markAt([box, redaction], { x: 30, y: 12 }, options), redaction);
  assert.equal(
    markAt([box, redaction], { x: 30, y: 12 }, { ...options, skip: redaction }),
    box,
  );
});

test("handles: middles only on sides from 48px; a line bends once it is long enough", () => {
  assert.deepEqual(
    markHandles(rect(0, 0, 20, 20), 1, measure).map((each) => each.id),
    ["nw", "ne", "se", "sw"],
  );
  assert.deepEqual(
    markHandles(rect(0, 0, 100, 100), 1, measure).map((each) => each.id),
    ["nw", "n", "ne", "e", "se", "s", "sw", "w"],
  );
  assert.deepEqual(
    markHandles(line(20, 0), 1, measure).map((each) => each.id),
    ["start", "end"],
  );
  assert.deepEqual(
    markHandles(line(100, 0), 1, measure).map((each) => each.id),
    ["start", "end", "bend"],
  );
  assert.equal(markHandles(label("hi"), 1, measure).length, 4);
  assert.equal(
    handleAt(rect(0, 0, 100, 100), { x: 99, y: 2 }, options)?.id,
    "ne",
  );
  assert.equal(handleAt(rect(0, 0, 100, 100), { x: 50, y: 50 }, options), null);
});

test("resize: corners keep the opposite corner; Shift squares rectangles", () => {
  const box = rect(0, 0, 100, 50);
  const dragged = dragHandle(box, "se", { x: 150, y: 80 });
  assert.deepEqual(
    [dragged.kind !== "pen" && "from" in dragged && dragged.from],
    [{ x: 0, y: 0 }],
  );
  const square = dragHandle(box, "se", { x: 150, y: 80 }, { shift: true });
  assert.ok("to" in square);
  assert.deepEqual(square.to, { x: 150, y: 150 });
  const wider = dragHandle(box, "e", { x: 200, y: 999 });
  assert.ok("to" in wider);
  assert.deepEqual(
    [wider.from, wider.to],
    [
      { x: 0, y: 0 },
      { x: 200, y: 50 },
    ],
  );
  const snapped = constrainPoint(
    "line",
    { x: 0, y: 0 },
    { x: 100, y: 10 },
    true,
  );
  assert.equal(Math.round(snapped.y), 0);
});

test("bend: the middle handle bends a line; back at the middle it straightens", () => {
  const straight = line(100, 0);
  const bent = dragHandle(straight, "bend", { x: 50, y: 30 }) as LineMark;
  assert.deepEqual(bent.bend, { u: 0.5, v: 0.3 });
  const handle = bendHandle(bent);
  assert.ok(Math.abs(handle.x - 50) < 1e-9 && Math.abs(handle.y - 30) < 1e-9);
  assert.deepEqual(bendThrough(bent.from, bent.to, handle), bent.bend);
  const back = dragHandle(bent, "bend", { x: 51, y: 2 }) as LineMark;
  assert.equal("bend" in back, false);
  // On the bend the line picks up along the curve, not the chord.
  assert.equal(markContains(bent, { x: 50, y: 29 }, options), true);
  assert.equal(markContains(bent, { x: 50, y: 0 }, options), false);
  // A straight arrow's head is the same either way.
  const arrow: LineMark = { ...line(100, 0), kind: "arrow" };
  const head = bentArrowHead(arrow);
  const plain = arrowHead(arrow.from, arrow.to, arrow.width);
  assert.deepEqual(head.shaftEnd, plain.shaftEnd);
  assert.equal(head.shaftControl, null);
  const curved = bentArrowHead({ ...arrow, bend: { u: 0.5, v: 0.3 } });
  assert.ok(curved.shaftControl && curved.shaftEnd.y > 0);
});

test("text: a corner drag scales the type, down to 8px, the opposite corner staying", () => {
  const words = label("hello");
  const before = measure(words);
  const grown = resizeText(
    words,
    "se",
    { x: before.x + before.width * 2 + 4, y: before.y + before.height * 2 + 4 },
    measure,
  );
  assert.equal(Math.round(grown.size * 1e6) / 1e6, 32);
  assert.deepEqual(grown.at, words.at);
  const shrunk = resizeText(words, "se", { x: 0, y: 0 }, measure);
  assert.equal(shrunk.size, 8);
  const fromTopLeft = resizeText(words, "nw", { x: 0, y: 0 }, measure);
  const after = measure(fromTopLeft);
  assert.ok(Math.abs(after.x + after.width - (before.x + before.width)) < 1e-9);
});

test("move: a mark stops when its middle reaches the edge", () => {
  const box = rect(0, 0, 20, 20);
  assert.deepEqual(
    clampMove(box, -50, 500, { width: 100, height: 100 }, measure),
    { dx: -10, dy: 90 },
  );
  const moved = moveMark(box, 5, 5);
  assert.ok("from" in moved);
  assert.deepEqual(moved.from, { x: 5, y: 5 });
});

test("history: replacing and removing are undoable steps; it keeps 100", () => {
  const a = rect(0, 0, 10, 10);
  const b = rect(0, 0, 20, 20);
  const one = commit(emptyHistory, [a]);
  const two = replaceMark(one, a, b);
  assert.deepEqual(two.present, [b]);
  assert.equal(two.past.length, 2);
  assert.equal(replaceMark(two, b, b), two);
  assert.deepEqual(removeMark(two, b).present, []);
  assert.equal(removeMark(two, a), two);
  let long = emptyHistory;
  for (let step = 0; step < historyLimit + 20; step++)
    long = commit(long, [rect(0, 0, step + 1, 1)]);
  assert.equal(long.past.length, historyLimit);
});

test("redact by text: the smallest word under the click, 2px out, revealed in 200ms", () => {
  const targets = [
    { x: 0, y: 0, width: 200, height: 40 },
    { x: 10, y: 10, width: 40, height: 12 },
  ];
  assert.deepEqual(textTargetAt(targets, { x: 20, y: 15 }), targets[1]);
  assert.equal(textTargetAt(targets, { x: 300, y: 15 }), null);
  const mark = targetRedaction(targets[1], "mosaic", 2);
  assert.deepEqual(mark, {
    kind: "redact",
    style: "mosaic",
    from: { x: 6, y: 6 },
    to: { x: 54, y: 26 },
  });
  assert.equal(revealProgress(0), 0);
  assert.equal(revealProgress(200), 1);
  assert.ok(revealProgress(100) > 0.5);
});

test("text targets: letter-like strokes make a word; a frame or a rule doesn't", () => {
  const width = 200;
  const height = 80;
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  const ink = (x: number, y: number) => {
    const at = (y * width + x) * 4;
    rgba[at] = rgba[at + 1] = rgba[at + 2] = 0;
  };
  // A "word": six 2px strokes, 12px high, 2px apart, at (20, 20).
  for (let stroke = 0; stroke < 6; stroke++)
    for (let y = 20; y < 32; y++)
      for (let x = 0; x < 2; x++) ink(20 + stroke * 4 + x, y);
  // A long rule under it.
  for (let x = 10; x < 190; x++) ink(x, 60);
  const boxes = findTextBoxes(rgba, width, height);
  assert.equal(boxes.length, 1);
  const [word] = boxes;
  assert.ok(word.x <= 20 && word.x + word.width >= 42);
  assert.ok(word.y <= 20 && word.y + word.height >= 31);
  assert.deepEqual(findTextBoxes(new Uint8ClampedArray(16), 2, 2), []);
});
