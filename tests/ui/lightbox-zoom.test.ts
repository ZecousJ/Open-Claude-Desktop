import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clickZoom,
  wheelZoom,
  zoomFrame,
  zoomTransform,
} from "../../src/lightbox/lightbox-model";

// A 400×300 picture fitted in the middle of a 1000×800 stage, 1600px wide naturally.
const frame = zoomFrame(
  { left: 300, top: 250, width: 400, height: 300 },
  1600,
  {
    width: 1000,
    height: 800,
  },
)!;

test("a click zooms to the natural size around the pointer, kept on screen", () => {
  assert.equal(frame.maxScale, 4);
  const centre = clickZoom(frame, { clientX: 500, clientY: 400 });
  assert.equal(centre.scale, 4);
  assert.equal(centre.tx, 0);
  assert.equal(centre.ty, 0);
  const corner = clickZoom(frame, { clientX: 320, clientY: 260 });
  // The point under the pointer stays put, as far as the picture can pan.
  assert.ok(corner.tx > 0 && corner.tx <= (400 * 4 - 1000) / 2);
  assert.ok(corner.ty > 0 && corner.ty <= (300 * 4 - 800) / 2);
});

test("a small picture still zooms to twice its fitted size", () => {
  const small = zoomFrame({ left: 0, top: 0, width: 400, height: 300 }, 300, {
    width: 1000,
    height: 800,
  })!;
  assert.equal(small.maxScale, 2);
});

test("ctrl + wheel starts at 1.25×, stops at the natural size, and lets go below 1.05×", () => {
  const pointer = { clientX: 500, clientY: 400 };
  const first = wheelZoom(null, frame, -5, pointer)!;
  assert.equal(first.scale, 1.25);
  let zoom: ReturnType<typeof wheelZoom> = first;
  for (let i = 0; i < 50; i++) zoom = wheelZoom(zoom, null, -100, pointer);
  assert.equal(zoom!.scale, 4);
  assert.equal(wheelZoom(first, null, 30, pointer), null);
  assert.equal(wheelZoom(null, frame, 50, pointer), null);
});

test("the transform moves, then scales", () => {
  assert.equal(
    zoomTransform({ tx: 10, ty: -5, scale: 2 }),
    "translate(10px, -5px) scale(2)",
  );
});
