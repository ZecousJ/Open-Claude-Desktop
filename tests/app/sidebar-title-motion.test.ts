import test from "node:test";
import assert from "node:assert/strict";
import {
  graphemes,
  runningDotMs,
  sharedPhaseDelay,
  titleRevealMs,
} from "../../src/sidebar/title-motion";

test("a title writes itself in whole characters, emoji and accents included", () => {
  assert.deepEqual(graphemes("Hi 👋🏽"), ["H", "i", " ", "👋🏽"]);
  assert.deepEqual(graphemes("été"), ["é", "t", "é"]);
  assert.deepEqual(graphemes(""), []);
});

test("the reveal lasts until the last character and four more steps", () => {
  assert.equal(titleRevealMs(0), 120);
  assert.equal(titleRevealMs(10), 420);
});

test("running dots share one breath, whenever they start", () => {
  assert.equal(runningDotMs, 1200);
  assert.equal(sharedPhaseDelay(0), "0ms");
  assert.equal(sharedPhaseDelay(300), "-300ms");
  // 2.5 breaths in: half-way through the breath, like a dot started at 600.
  assert.equal(sharedPhaseDelay(3000), sharedPhaseDelay(600));
  assert.equal(sharedPhaseDelay(1199.6), "-1200ms");
});
