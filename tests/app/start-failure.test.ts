import test from "node:test";
import assert from "node:assert/strict";
import {
  startFailureCategory,
  startFailureMessage,
} from "../../src/app/start-failure";

test("a cloud session start that failed on the connection or the server says what to do", () => {
  assert.equal(
    startFailureCategory(new TypeError("Failed to fetch")),
    "network_error",
  );
  assert.equal(
    startFailureCategory(new Error("connect ECONNREFUSED 1.2.3.4:443")),
    "network_error",
  );
  assert.equal(
    startFailureCategory(new Error("Request failed: 502 Bad Gateway")),
    "api_server_error",
  );
  assert.equal(
    startFailureCategory(new Error("This repository is private.")),
    undefined,
  );
  assert.equal(
    startFailureMessage("network_error"),
    "Your new session couldn’t start. Check your connection, then send your prompt again.",
  );
  assert.equal(
    startFailureMessage("api_server_error"),
    "Your new session couldn’t start. Send your prompt again in a moment.",
  );
});
