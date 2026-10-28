import test from "node:test";
import assert from "node:assert/strict";
import {
  linkFailed,
  linkFailureMessage,
} from "../../src/cowork/link-to-computer";

test("a task that could not be linked says why in the linking's own words, never a raw error", () => {
  for (const reason of [
    "Sign in to Claudex again on this computer, then link this task.",
    "Couldn’t connect. Check your internet connection, then try again.",
    "This task is in the middle of a step. Wait for it to finish (or stop it), then link again.",
    "This task is too long to link to a computer. To use this computer’s files and apps, start a new task here.",
    "A scheduled task uses this task, so it can’t be linked to a computer.",
    "Something earlier in this task can’t be carried over to a computer. To use this computer’s files and apps, start a new task here.",
  ])
    assert.equal(
      linkFailureMessage(
        new Error(`Error invoking remote method 'link': Error: ${reason}`),
      ),
      reason,
    );
  assert.equal(
    linkFailureMessage(new Error("ZodError: [ { path: ['conversation'] } ]")),
    linkFailed,
  );
  assert.equal(linkFailureMessage("ENOSPC: no space left"), linkFailed);
});
