import test from "node:test";
import assert from "node:assert/strict";
import {
  edgeHint,
  edgeZone,
  peekCloseMs,
  peekDwellMs,
} from "../../src/sidebar/sidebar-peek";

test("the left edge opens within 16px, hints within 48px, below the title bar", () => {
  assert.equal(edgeZone(0, 300, 800), "open");
  assert.equal(edgeZone(16, 300, 800), "open");
  assert.equal(edgeZone(17, 300, 800), "hint");
  assert.equal(edgeZone(48, 300, 800), "hint");
  assert.equal(edgeZone(49, 300, 800), "far");
  // The title bar is a drag region; the edge starts under it.
  assert.equal(edgeZone(4, 20, 800), "far");
  assert.equal(edgeZone(4, 800, 800), "far");
});

test("the hint strip shows near the edge, widens where it opens, and goes once open", () => {
  assert.equal(edgeHint("far", false), "none");
  assert.equal(edgeHint("hint", false), "shown");
  assert.equal(edgeHint("open", false), "snap");
  assert.equal(edgeHint("open", true), "none");
});

test("the peek waits 100ms to open and 180ms to close, as the original", () => {
  assert.equal(peekDwellMs, 100);
  assert.equal(peekCloseMs, 180);
});
