import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControlBar } from "../../src/simulators/SimulatorControlBar";
import {
  addMark,
  arrowHead,
  clearAll,
  emptyHistory,
  isEmptyMark,
  redo,
  textureGrey,
  undo,
  type Mark,
} from "../../src/simulators/annotate-sketch";

const bar = (kind: "ios" | "android", onAnnotate?: () => void) =>
  renderToStaticMarkup(
    createElement(ControlBar, {
      kind,
      disabled: false,
      busy: false,
      recordingStartedAt: null,
      logsOpen: false,
      canRecord: kind === "ios",
      onButton: () => {},
      onScreenshot: () => {},
      onToggleRecording: () => {},
      onToggleLogs: () => {},
      onAnnotate,
    }),
  );

const order = (markup: string) =>
  [...markup.matchAll(/aria-label="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((label) => label !== "Device controls");

test("Annotate sits where the original puts it, and only where a composer takes it", () => {
  assert.deepEqual(order(bar("android", () => {})), [
    "Back",
    "Home",
    "Recents",
    "Lock",
    "Volume up",
    "Volume down",
    "Annotate",
    "Save screenshot",
    "Show logs",
  ]);
  assert.deepEqual(order(bar("ios", () => {})), [
    "Home",
    "Lock",
    "Save screenshot",
    "Record video",
    "Annotate",
    "Show logs",
  ]);
  assert.doesNotMatch(bar("ios"), /Annotate/);
});

const line = (x: number, y: number): Mark => ({
  kind: "line",
  color: "#E03131",
  width: 4,
  from: { x: 0, y: 0 },
  to: { x, y },
});

test("marks: a click without a drag is no mark; small redactions are dropped", () => {
  assert.equal(isEmptyMark(line(0, 0)), true);
  assert.equal(isEmptyMark(line(5, 0)), false);
  const redact = (x: number, y: number): Mark => ({
    kind: "redact",
    style: "solid",
    from: { x: 0, y: 0 },
    to: { x, y },
  });
  assert.equal(isEmptyMark(redact(2, 2)), true);
  assert.equal(isEmptyMark(redact(10, 0)), true);
  assert.equal(isEmptyMark(redact(10, 10)), false);
  assert.equal(
    isEmptyMark({
      kind: "text",
      color: "#000",
      size: 16,
      at: { x: 0, y: 0 },
      text: "  ",
    }),
    true,
  );
});

test("Undo, Redo and Clear all", () => {
  let history = addMark(emptyHistory, line(0, 0));
  assert.equal(history, emptyHistory);
  history = addMark(history, line(10, 0));
  history = addMark(history, line(20, 0));
  assert.equal(history.present.length, 2);
  history = undo(history);
  assert.equal(history.present.length, 1);
  history = redo(history);
  assert.equal(history.present.length, 2);
  history = clearAll(history);
  assert.equal(history.present.length, 0);
  // Clear all can be undone; a new mark drops what could be redone.
  history = undo(history);
  assert.equal(history.present.length, 2);
  history = undo(history);
  history = addMark(history, line(30, 0));
  assert.equal(history.future.length, 0);
  assert.equal(redo(history), history);
  assert.equal(clearAll(emptyHistory), emptyHistory);
});

test("the arrow's head is four strokes long and the shaft stops under it", () => {
  const head = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
  assert.equal(head.size, 16);
  assert.deepEqual(head.shaftEnd, { x: 100 - 16 * 0.7, y: 0 });
  assert.deepEqual(head.corners, [
    { x: 84, y: -8 },
    { x: 84, y: 8 },
  ]);
});

test("texture greys stay within each style's range", () => {
  assert.equal(textureGrey("mosaic", 0), "#383838");
  assert.equal(textureGrey("mosaic", 1), "#c8c8c8");
  assert.equal(textureGrey("noise", 0), "#101010");
  assert.equal(textureGrey("noise", 1), "#f0f0f0");
});
