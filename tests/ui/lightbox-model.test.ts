import test from "node:test";
import assert from "node:assert/strict";
import {
  clampIndex,
  containedInset,
  counterLabel,
  keyTarget,
  lightboxState,
  setLightboxState,
  subscribeLightbox,
  trackOffset,
} from "../../src/lightbox/lightbox-model";

test("the carousel centres the current 75vw slide, 32px between slides", () => {
  assert.equal(trackOffset(0), "translateX(calc(12.5vw - 0vw - 0px))");
  assert.equal(trackOffset(2), "translateX(calc(12.5vw - 150vw - 64px))");
});

test("arrows, Home and End move within the list without wrapping", () => {
  assert.equal(keyTarget("ArrowLeft", 0, 3), 0);
  assert.equal(keyTarget("ArrowRight", 0, 3), 1);
  assert.equal(keyTarget("ArrowRight", 2, 3), 2);
  assert.equal(keyTarget("Home", 2, 3), 0);
  assert.equal(keyTarget("End", 0, 3), 2);
  assert.equal(keyTarget("Enter", 1, 3), undefined);
  assert.equal(clampIndex(9, 3), 2);
  assert.equal(clampIndex(-1, 3), 0);
  assert.equal(counterLabel(1, 4), "2 of 4");
});

test("a letterboxed picture's morph starts from the picture, not its box", () => {
  // A 200×100 picture in a 100×100 box sits 25px from the top and bottom.
  assert.equal(
    containedInset({ width: 100, height: 100 }, { width: 200, height: 100 }),
    "25% 0% 25% 0%",
  );
  // A picture that fills its box needs no inset.
  assert.equal(
    containedInset({ width: 100, height: 50 }, { width: 200, height: 100 }),
    undefined,
  );
  assert.equal(
    containedInset({ width: 0, height: 50 }, { width: 200, height: 100 }),
    undefined,
  );
});

test("the store tells its listeners when the lightbox opens and closes", () => {
  let calls = 0;
  const stop = subscribeLightbox(() => calls++);
  setLightboxState({ images: [{ src: "data:," }], index: 0 });
  assert.equal(lightboxState()?.index, 0);
  setLightboxState(undefined);
  stop();
  setLightboxState(undefined);
  assert.equal(calls, 2);
});
