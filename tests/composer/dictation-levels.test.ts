import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  DictationLevels,
  frequencyLevel,
} from "../../src/voice/DictationLevels";

test("microphone meter averages all byte frequencies over 128 and clamps at one", () => {
  assert.equal(frequencyLevel(new Uint8Array()), 0);
  assert.equal(frequencyLevel(new Uint8Array([0, 0])), 0);
  assert.equal(frequencyLevel(new Uint8Array([0, 128])), 0.5);
  assert.equal(frequencyLevel(new Uint8Array([128, 128])), 1);
  assert.equal(frequencyLevel(new Uint8Array([255, 255])), 1);
});

test("microphone meter is a horizontal track, not three animated SVG bars", () => {
  const html = renderToStaticMarkup(createElement(DictationLevels));
  assert.match(html, /dictation-input-level/);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /svg|rect|pulse/);
});
