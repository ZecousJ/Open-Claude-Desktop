import assert from "node:assert/strict";
import test from "node:test";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { deleteOfficialCoworkSession } from "../../runner/src/official-cowork-delete";

test("Cowork deletion targets one owned active session and confirms removal", async () => {
  const owner = "owner", identity = {};
  const session = { id: "cowork", createdAt: 1, mode: "cowork", environment: { kind: "space" }, turns: [] };
  const store = { conversations: [session] };
  const ctx = { activeAccount: { id: owner }, store, officialSessionIdentity: () => identity };
  let calls = 0;
  const dispatcher = { async run(frame: any, expected: any) {
    calls++;
    assert.equal(frame.method, "deleteConversation");
    assert.deepEqual(frame.args, [session.id]);
    assert.equal(expected.coworkDelete.current(), true);
    store.conversations = [];
  } };
  const key = cloudCodeSessionKey(session, owner);
  const request = { codeOrganizationId: organizationUuid(owner), contentType: "application/json", body: Buffer.from("{}") };
  const call = (overrides = {}, target = key, current = () => true) =>
    deleteOfficialCoworkSession(dispatcher as never, {} as never, ctx as never, target, { ...request, ...overrides }, current);
  assert.equal((await call({ body: Buffer.from('{"extra":true}') })).status, 400);
  assert.equal((await call({}, "unknown")).status, 404);
  assert.equal((await call({ codeOrganizationId: organizationUuid("other") })).status, 404);
  assert.equal((await call({}, key, () => false)).status, 409);
  assert.equal(calls, 0);
  assert.equal((await call()).status, 200);
  assert.equal(calls, 1);
  assert.equal((await call()).status, 404);
});

test("Cowork deletion rejects archived, foreign, and unconfirmed sessions", async () => {
  const owner = "owner", identity = {};
  const session = { id: "cowork", createdAt: 1, mode: "cowork", environment: { kind: "space" }, turns: [], archived: true, sessionAuthors: { ownerAccountUuid: owner, viewerAccountUuid: owner } };
  const store = { conversations: [session] };
  const ctx = { activeAccount: { id: owner }, store, officialSessionIdentity: () => identity };
  const key = cloudCodeSessionKey(session, owner);
  const request = { codeOrganizationId: organizationUuid(owner), contentType: "application/json", body: Buffer.from("{}") };
  let calls = 0;
  const dispatcher = { async run() { calls++; } };
  const call = () => deleteOfficialCoworkSession(dispatcher as never, {} as never, ctx as never, key, request, () => true);
  assert.equal((await call()).status, 404);
  session.archived = false;
  session.sessionAuthors.ownerAccountUuid = "other";
  assert.equal((await call()).status, 404);
  session.sessionAuthors.ownerAccountUuid = owner;
  assert.equal((await call()).status, 409);
  assert.equal(calls, 1);
});
