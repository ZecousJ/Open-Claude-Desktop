import test from "node:test";
import assert from "node:assert/strict";
import { microphoneError } from "../../src/voice/microphone-error";

const named = (name: string) => new DOMException("raw browser text", name);

test("a refused, missing or busy microphone gets a plain sentence", () => {
  assert.match(
    microphoneError(named("NotAllowedError")).message,
    /Microphone access was not granted/,
  );
  assert.match(
    microphoneError(named("NotFoundError")).message,
    /No microphone found\. Connect a microphone and try again\./,
  );
  assert.match(
    microphoneError(named("OverconstrainedError")).message,
    /No microphone found\. Connect a microphone and try again\./,
  );
  assert.match(
    microphoneError(named("NotReadableError")).message,
    /Your microphone isn’t available/,
  );
});

test("other errors keep their own message", () => {
  assert.equal(
    microphoneError(Error("Something else")).message,
    "Something else",
  );
  assert.equal(microphoneError("odd").message, "The microphone failed.");
});
