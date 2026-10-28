import test from "node:test";
import assert from "node:assert/strict";
import {
  MicSilenceMonitor,
  micSilencePromptMs,
  pcmRms,
} from "../../src/voice/mic-silence";

const chunk = (value: number, samples = 160) => {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, value, true);
  return bytes;
};

test("a chunk's loudness is the RMS of its 16-bit samples", () => {
  assert.equal(pcmRms(chunk(0)), 0);
  assert.equal(Math.round(pcmRms(chunk(1000))), 1000);
  assert.equal(pcmRms(new Uint8Array(0)), 0);
});

test("five quiet seconds while listening ask about the microphone; sound clears it", () => {
  const monitor = new MicSilenceMonitor(0);
  monitor.hear(chunk(2));
  assert.equal(monitor.check(4000, false), null);
  monitor.hear(chunk(2));
  assert.equal(monitor.check(micSilencePromptMs, false), "silent");
  monitor.hear(chunk(500));
  assert.equal(monitor.check(micSilencePromptMs + 500, false), null);
  // A muted input track says so at once.
  assert.equal(monitor.check(micSilencePromptMs + 1000, true), "muted");
});
