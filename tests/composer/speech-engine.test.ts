import test from "node:test";
import assert from "node:assert/strict";
import { speechEngineFor } from "../../src/voice/useSpeechEngine";
import { recognitionErrorText } from "../../src/voice/browser-recognition";

const on = { transcription: true, maxTranscriptionBytes: null, maxSeconds: 60 };
const off = {
  transcription: false,
  maxTranscriptionBytes: null,
  maxSeconds: null,
};

test("the service transcribes when it can; the browser only when chosen", () => {
  assert.equal(speechEngineFor(true, on, false, false), "service");
  assert.equal(speechEngineFor(true, on, true, true), "service");
  assert.equal(speechEngineFor(true, off, true, true), "browser");
  assert.equal(speechEngineFor(true, undefined, true, true), "browser");
  // Never a silent fallback: not chosen, or nothing to choose.
  assert.equal(speechEngineFor(true, off, false, true), undefined);
  assert.equal(speechEngineFor(true, off, true, false), undefined);
});

test("the administrator turning voice off turns every engine off", () => {
  assert.equal(speechEngineFor(false, on, true, true), undefined);
  assert.equal(speechEngineFor(false, off, true, true), undefined);
});

test("recognition errors say what went wrong, and silence is not one", () => {
  assert.equal(recognitionErrorText("no-speech"), undefined);
  assert.equal(recognitionErrorText("aborted"), undefined);
  assert.match(recognitionErrorText("not-allowed")!, /Microphone access/);
  assert.match(recognitionErrorText("network")!, /speech service/);
  assert.match(recognitionErrorText("audio-capture")!, /No microphone/);
  assert.match(recognitionErrorText("weird")!, /failed/);
});
