import assert from "node:assert/strict";
import test from "node:test";
import { createOfficialReadFetch } from "../src-web/official/read-fetch";
import { officialSharedChatReadPath, officialSharedChatToken, readOfficialSharedChatSnapshot } from "../src-web/official/shared-chat";
import { json, signedInBridge } from "./app/web-bridge-fakes.test";

const origin = "https://claudex.example";
const organization = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const token = "AbCdEfGhIjKlMnOpQrStUvWxYz012345678901234567";
const rendering = "?rendering_mode=messages&render_all_tools=true";
const originalRead = `/api/organizations/${organization}/chat_snapshots/${id}${rendering}`;
const serviceRead = `/api/v1/claudex/sharing/shared-with-me/${token}`;

test("the official visitor reads the canonical share with the browser account and displays the saved messages", async () => {
  assert.equal(officialSharedChatToken(`/shared/${token}`), token);
  assert.equal(officialSharedChatToken(`/share/${id}`), undefined);
  const { bridge, tab, calls } = await signedInBridge();
  let canRead = true;
  tab.routes.unshift((request) => {
    if (request.url !== serviceRead) return;
    assert.equal(request.method, "GET");
    assert.equal(request.headers.get("authorization"), "Bearer at-1");
    return canRead
      ? json({ code: 0, data: {
          token, kind: "conversation", title: "Shared Chat", owner: "owner@example.com",
          snapshot_at: "2026-11-13T00:00:00Z",
          snapshot: { messages: [
            { role: "user", text: "Fixture question" },
            { role: "assistant", text: "Fixture answer", activity: ["Searched the web"] },
          ] },
        } })
      : json({ code: 404, message: "This share is not available." }, 404);
  });
  const fetch = createOfficialReadFetch(
    origin,
    (request) => {
      assert.deepEqual(request, { method: "GET", path: officialSharedChatReadPath });
      return readOfficialSharedChatSnapshot({ read: bridge.readSharedChat, token, id });
    },
    async () => assert.fail("The official snapshot uses the scoped browser bridge."),
    undefined, undefined, undefined, undefined,
    { organization, sharedChatSnapshotId: id },
  );
  try {
    const response = await fetch(originalRead);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const snapshot = await response.json();
    assert.equal(snapshot.uuid, id);
    assert.equal(snapshot.snapshot_name, "Shared Chat");
    assert.equal(snapshot.is_public, false);
    assert.equal(snapshot.created_by, "owner@example.com");
    assert.equal(snapshot.chat_messages[1].parent_message_uuid, snapshot.chat_messages[0].uuid);
    assert.deepEqual(snapshot.chat_messages.map(({ sender, content }: { sender: string; content: { text: string }[] }) =>
      [sender, content.map((block) => block.text)]), [
      ["human", ["Fixture question"]],
      ["assistant", ["Searched the web", "Fixture answer"]],
    ]);
    assert.equal(JSON.stringify(snapshot).includes(token), false);
    assert.deepEqual(calls, []);

    canRead = false;
    const denied = await fetch(originalRead);
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { error: { type: "not_found_error" } });

    assert.equal((await fetch(originalRead.replace(`/chat_snapshots/${id}`, `/chat_snapshots/${organization}`))).status, 501);
    assert.equal((await fetch(originalRead.replace(organization, id))).status, 501);
    assert.equal((await fetch(originalRead + "&extra=1")).status, 501);
    assert.equal((await fetch(originalRead, { method: "POST" })).status, 501);
    assert.equal((await fetch(officialSharedChatReadPath)).status, 501);
    assert.equal(tab.requests.filter((request) => request.url === serviceRead).length, 2);
  } finally {
    bridge.dispose();
  }
});
