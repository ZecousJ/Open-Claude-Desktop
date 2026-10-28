import test from "node:test";
import assert from "node:assert/strict";
import type { HostedShare } from "../../shared/sharing-api";
import {
  shareForToken,
  sharedByMe,
} from "../../src/collections/shared/SharedChatPage";
import { sharedConversationIds } from "../../src/collections/shared/shared-ids";

const share = (fields: Partial<HostedShare>): HostedShare => ({
  id: "1",
  kind: "conversation",
  sourceKey: "c1",
  title: "Plan",
  url: "https://share.example.test/s/pub",
  createdAt: 1,
  snapshotAt: 1,
  status: "active",
  ...fields,
});

test("the sharer reading their own shared chat is told it is the copy", () => {
  assert.equal(
    sharedByMe({ owner: "Ann@Example.com" }, "ann@example.com"),
    true,
  );
  assert.equal(
    sharedByMe({ owner: "bo@example.com" }, "ann@example.com"),
    false,
  );
  assert.equal(sharedByMe({ owner: "" }, "ann@example.com"), false);
  assert.equal(sharedByMe({ owner: "ann@example.com" }, undefined), false);
  assert.equal(sharedByMe(null, "ann@example.com"), false);
});

test("chats with a live link are the ones the history marks Shared", () => {
  const ids = sharedConversationIds([
    share({ id: "1", sourceKey: "c1" }),
    share({ id: "2", sourceKey: "c2", status: "disabled" }),
    share({ id: "3", sourceKey: "" }),
  ]);
  assert.deepEqual([...ids], ["c1"]);
});

test("the original chat is found through the share whose link ends with the token", () => {
  const shares = [
    share({ id: "1", sourceKey: "c1" }),
    share({
      id: "2",
      sourceKey: "c2",
      access: "invited",
      inviteUrl: "https://app.example.test/shared/tok2",
    }),
  ];
  assert.equal(shareForToken(shares, "tok2")?.sourceKey, "c2");
  assert.equal(shareForToken(shares, "pub")?.sourceKey, "c1");
  assert.equal(shareForToken(shares, "nope"), undefined);
  // A token that only ends another one does not match.
  assert.equal(shareForToken(shares, "ok2"), undefined);
});
