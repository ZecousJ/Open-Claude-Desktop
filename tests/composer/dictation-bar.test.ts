import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DictationBar,
  waveformBars,
  waveformLevel,
} from "../../src/voice/DictationBar";

test("the waveform uses the official RMS floor, gain, spacing and edge taper", () => {
  assert.equal(waveformLevel(new Uint8Array(1024).fill(128)), 0);
  assert.equal(waveformLevel(new Uint8Array(1024).fill(255)), 1);
  const bars = waveformBars([0, 0.5, 1], 140, 20, 0);
  assert.deepEqual(bars[0], { x: 119, y: 9, height: 2 });
  assert.equal(bars[1].x - bars[0].x, 7);
  assert.equal(bars[2].x, 133);
  assert.ok(bars[2].height < 20);
  assert.ok(bars[2].height > 2);
});

test("the full-width recording bar keeps Cancel and Done visible, disabling Done while connecting", () => {
  for (const connecting of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(DictationBar, {
        connecting,
        onCancel() {},
        onDone() {},
      }),
    );
    assert.match(html, /class="dictation-bar"/);
    assert.match(html, /class="dictation-waveform"/);
    assert.match(html, /aria-label="Cancel dictation"/);
    assert.match(html, /class="dictation-action dictation-done"/);
    assert.equal(
      /aria-label="Finish dictation" disabled/.test(html),
      connecting,
    );
    assert.doesNotMatch(html, /pill|dictation-levels/);
  }
});
