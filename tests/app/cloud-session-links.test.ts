import test from "node:test";
import assert from "node:assert/strict";
import {
  cloudSessionUrl,
  desktopSessionLink,
} from "../../src/conversation/cloud-session-links";
import { parseDeepLink } from "../../shared/deep-links";

test("a cloud session's link is its own address, and the desktop link opens the same session", () => {
  assert.equal(
    cloudSessionUrl("abc-123", "https://claudex.example.com"),
    "https://claudex.example.com/code/abc-123",
  );
  assert.deepEqual(parseDeepLink(desktopSessionLink("abc-123")), {
    kind: "conversation",
    id: "abc-123",
  });
});
