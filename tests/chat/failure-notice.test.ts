import test from "node:test";
import assert from "node:assert/strict";
import { failureMessage } from "../../src/transcript/reply-failure";

const raw =
  'unexpected status 502 Bad Gateway: The model service returned HTTP 502: {"error":{"message":"Upstream service temporarily unavailable","type":"upstream_error"}}, url: http://127.0.0.1:34217/v1/responses';

test("policy and content filtering reasons take precedence over transport details", () => {
  assert.equal(
    failureMessage("The model provider blocked this response."),
    failureMessage("content_filter_blocked"),
  );
  assert.equal(
    failureMessage('403 {"reason":"policy_deny"}'),
    "This message was blocked by your organization’s policy.",
  );
  assert.equal(
    failureMessage("502 upstream: content_filter_blocked"),
    "This response was blocked by content filtering. Rephrase your message or try again.",
  );
});

test("a failed reply's reason is one plain sentence, never the engine's text", () => {
  const unavailable = failureMessage(raw);
  assert.equal(
    unavailable,
    "Claudex is temporarily unavailable. Try again in a moment.",
  );
  assert.doesNotMatch(unavailable, /127\.0\.0\.1|502|\{|http/i);
  assert.equal(
    failureMessage("HTTP 429 too many requests"),
    "The service is busy right now. Wait a moment, then try again.",
  );
  // An overloaded model is busy (the original's wording, with our name).
  assert.equal(
    failureMessage('unexpected status 529: {"type":"overloaded_error"}'),
    "Claudex is busy right now. Try again in a moment.",
  );
  // A lost connection or a reply cut short, in the live bundle's sentence.
  for (const cause of [
    "request timed out",
    "fetch failed",
    "stream disconnected before completion",
  ])
    assert.equal(
      failureMessage(cause),
      "Claudex couldn’t finish this response. Try again in a moment.",
    );
  // A 401 is the sign-in banner's to say; the reply just didn’t load.
  assert.equal(
    failureMessage("401 Unauthorized"),
    "This response didn’t load.",
  );
  assert.equal(
    failureMessage("403 Forbidden"),
    "The service refused the request. Sign in again, then try again.",
  );
  // Unclassified, as the original words it.
  assert.equal(failureMessage(undefined), "This response didn’t load.");
  assert.equal(failureMessage("something odd"), "This response didn’t load.");
});
