import test from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_FLASH_MS,
  REVIEW_SCROLL_MS,
  easeOutQuad,
  stepShare,
} from "../../src/changes/review-scroll";

test("the review jump takes 400ms on an ease-out quad", () => {
  assert.equal(REVIEW_SCROLL_MS, 400);
  assert.equal(REVIEW_FLASH_MS, 1000);
  assert.equal(easeOutQuad(0), 0);
  assert.equal(easeOutQuad(0.5), 0.75);
  assert.equal(easeOutQuad(1), 1);
});

test("each frame covers its share of the distance left", () => {
  // Halfway through the curve, a step to 0.75 covers half of what is left.
  assert.equal(stepShare(0.5, 0.75), 0.5);
  assert.equal(stepShare(0, 0.36), 0.36);
  assert.equal(stepShare(1, 1), 1);
  // Following the shares lands exactly on a still target.
  let position = 0;
  let previous = 0;
  for (const t of [0.25, 0.5, 0.75, 1]) {
    const eased = easeOutQuad(t);
    position += (100 - position) * stepShare(previous, eased);
    previous = eased;
  }
  assert.equal(Math.round(position * 1000) / 1000, 100);
});
