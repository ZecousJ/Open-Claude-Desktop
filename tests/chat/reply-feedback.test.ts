import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReplyFeedback } from "../../electron/conversations/reply-feedback";

test("reply ratings persist per account and deleting a conversation removes only its ratings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-feedback-"));
  try {
    const first = path.join(root, "first"),
      second = path.join(root, "second");
    const feedback = new ReplyFeedback(first);
    feedback.set("conversation-a", "turn-one", "up");
    feedback.set("conversation-b", "turn-two", "down");
    assert.deepEqual(new ReplyFeedback(second).all(), {});
    const loaded = new ReplyFeedback(first);
    assert.equal(
      loaded.all()[JSON.stringify(["conversation-a", "turn-one"])],
      "up",
    );
    loaded.deleteConversation("conversation-a");
    assert.equal(
      loaded.all()[JSON.stringify(["conversation-a", "turn-one"])],
      undefined,
    );
    assert.equal(
      loaded.all()[JSON.stringify(["conversation-b", "turn-two"])],
      "down",
    );
    loaded.set("conversation-b", "turn-two", null);
    assert.deepEqual(new ReplyFeedback(first).all(), {});
    assert.doesNotMatch(
      fs.readFileSync(path.join(first, "reply-feedback.json"), "utf8"),
      /password|apiKey|reply text/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt reply feedback is preserved instead of overwritten", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-feedback-corrupt-"),
  );
  try {
    const filename = path.join(root, "reply-feedback.json");
    fs.writeFileSync(filename, "{broken");
    assert.throws(() => new ReplyFeedback(root), /cannot be read/);
    assert.equal(fs.readFileSync(filename, "utf8"), "{broken");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
