import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOfficialConversationMutation } from "../../runner/src/official-ui-conversation-mutation";
import {
  isOfficialUiAction,
  officialUiRequestMaxBytes,
} from "../../shared/official-ui-web";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";

const base =
  "/api/organizations/11111111-1111-4111-8111-111111111111/chat_conversations/22222222-2222-4222-8222-222222222222";
const json = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

test("conversation mutation allowlist is method-specific and excludes grants and unexpected paths", () => {
  for (const method of ["PUT", "PATCH", "DELETE"])
    assert.equal(isOfficialUiAction(method, base), true);
  assert.equal(isOfficialUiAction("POST", base + "/stop_response"), true);
  assert.equal(isOfficialUiAction("PUT", base + "/read_state"), true);
  assert.equal(isOfficialUiAction("PUT", base + "?rendering_mode=raw"), true);
  const bulk = base.replace(/[^/]+$/, "delete_many");
  assert.equal(isOfficialUiAction("POST", bulk), true);
  for (const [method, path] of [
    ["GET", base],
    ["POST", base],
    ["PATCH", base + "/share"],
    ["PUT", base + "?rendering_mode=raw&extra=1"],
    ["PATCH", base + "?rendering_mode=raw"],
    ["POST", base + "/stop_response?x=1"],
    ["DELETE", base + "/../account"],
    ["POST", bulk + "?extra=1"],
    ["DELETE", bulk],
  ])
    assert.equal(isOfficialUiAction(method, path), false, `${method} ${path}`);
});

test("conversation mutation payloads reject ignored or dangerous fields before dispatch", () => {
  const request = (value: unknown) => ({
    method: "PATCH" as const,
    path: base,
    body: json(value),
    contentType: "application/json",
  });
  const archive = (value: unknown) => validateOfficialConversationMutation({
    ...request(value), method: "PUT", path: base + "?rendering_mode=raw",
  });
  assert.equal(archive({ is_archived: true }), true);
  assert.equal(archive({ is_archived: false }), true);
  assert.equal(archive({ is_archived: true, name: "n" }), false);
  assert.equal(
    validateOfficialConversationMutation(
      request({ name: "New title", is_starred: true, is_archived: false }),
    ),
    true,
  );
  for (const value of [
    {},
    [],
    null,
    { name: " " },
    { name: "x".repeat(1001) },
    { is_starred: "true" },
    { cwd: "/private" },
    { project_uuid: "other" },
    { name: "n", unknown: true },
  ])
    assert.equal(validateOfficialConversationMutation(request(value)), false);
  assert.equal(
    validateOfficialConversationMutation({
      ...request({ name: "n" }),
      body: new Uint8Array([255]),
    }),
    false,
  );
  assert.equal(
    validateOfficialConversationMutation({
      ...request({ name: "n" }),
      contentType: "application/proto",
    }),
    false,
  );
  assert.equal(
    validateOfficialConversationMutation({
      ...request({ name: "n" }),
      body: new Uint8Array(officialUiRequestMaxBytes + 1),
    }),
    false,
  );
  assert.equal(
    validateOfficialConversationMutation({
      method: "POST",
      path: base + "/stop_response",
    }),
    true,
  );
  assert.equal(
    validateOfficialConversationMutation({
      method: "DELETE",
      path: base,
      body: json({ recurse: true }),
      contentType: "application/json",
    }),
    false,
  );
  assert.equal(
    validateOfficialConversationMutation({
      method: "PUT",
      path: base + "/read_state",
      body: json({ unread: false }),
      contentType: "application/json",
    }),
    true,
  );
  assert.equal(
    validateOfficialConversationMutation({
      method: "PUT",
      path: base + "/read_state",
      body: json({ unread: true }),
      contentType: "application/json",
    }),
    false,
  );
});

test("browser forwards supported mutations only through explicitly enabled action transport", async () => {
  const calls: any[] = [];
  const read = async () => {
    throw Error("Must not route mutations through read transport");
  };
  const native = async () => {
    throw Error("Must not forward unsupported official API");
  };
  const disabled = createOfficialReadFetch(
    "https://example.test",
    read,
    native,
  );
  assert.equal(
    (
      await disabled(base, {
        method: "PATCH",
        body: JSON.stringify({ name: "n" }),
      })
    ).status,
    501,
  );
  const enabled = createOfficialReadFetch(
    "https://example.test",
    read,
    native,
    undefined,
    async (request) => {
      calls.push(request);
      return {
        status: 204,
        contentType: "application/json",
        body: new Uint8Array(),
      };
    },
  );
  const response = await enabled(base, {
    method: "PATCH",
    body: JSON.stringify({ name: "n" }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(calls[0].method, "PATCH");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[0].body)), {
    name: "n",
  });
  const sidebarRow = {
    uuid: base.split("/").at(-1),
    name: "Sidebar conversation",
    model: "gpt-6.2-sol",
    is_temporary: false,
  };
  assert.equal((await enabled(base, {
    method: "DELETE",
    body: JSON.stringify(sidebarRow),
    headers: { "content-type": "application/json" },
  })).status, 204);
  assert.deepEqual(calls[1], { method: "DELETE", path: base });
  assert.equal(
    (await enabled(base + "/stop_response", { method: "POST" })).status,
    204,
  );
  assert.equal(
    (await enabled(base + "?admin=true", { method: "DELETE" })).status,
    501,
  );
  assert.equal(
    (await enabled(base + "?rendering_mode=raw", {
      method: "PUT", body: JSON.stringify({ is_archived: true }),
      headers: { "content-type": "application/json" },
    })).status,
    204,
  );
  assert.equal(calls[3].path, base + "?rendering_mode=raw");
  const bulk = base.replace(/[^/]+$/, "delete_many");
  const bulkBody = { conversation_uuids: ["22222222-2222-4222-8222-222222222222"] };
  assert.equal((await enabled(bulk, { method: "POST", body: JSON.stringify(bulkBody), headers: { "content-type": "application/json" } })).status, 204);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[4].body)), bulkBody);
  assert.equal((await enabled(bulk + "?extra=1", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status, 501);
  assert.equal(calls.length, 5);
});


test("REST Stop accepts only a bounded completion request identifier in addition to legacy empty body", () => {
  const stop = (body: unknown) => validateOfficialConversationMutation({ method: "POST", path: base + "/stop_response", body: json(body), contentType: "application/json" });
  assert.equal(stop({completion_request_id:"11111111-1111-7111-8111-111111111111"}), true);
  for (const body of [{completion_request_id:"wrong"},{completion_request_id:null},{completion_request_id:"11111111-1111-7111-8111-111111111111",force:true},[]]) assert.equal(stop(body), false);
});

test("Chat read state accepts the original POST body and preserves legacy clearing", () => {
  const validate = (method: "POST" | "PUT", body: unknown) =>
    validateOfficialConversationMutation({
      method,
      path: base + "/read_state",
      contentType: "application/json",
      body: json(body),
    });
  for (const state of ["read", "unread"])
    assert.equal(validate("POST", { state }), true);
  for (const body of [{}, { unread: false }]) {
    assert.equal(validate("POST", body), true);
    assert.equal(validate("PUT", body), true);
  }
  for (const body of [
    { unread: true },
    { state: "read", unread: false },
    { state: "unread", name: "Other update" },
    { state: "pending" },
    null,
  ]) assert.equal(validate("POST", body), false);
  assert.equal(validate("PUT", { state: "unread" }), false);
});
