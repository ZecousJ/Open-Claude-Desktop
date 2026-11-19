import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeviceMethods } from "../electron/remote-control/device-methods";
import { DeviceTrustStore } from "../electron/remote-control/device-trust-store";
import { createOfficialRemoteCodeHost } from "../electron/remote-control/official-code";
import { defaultSettings } from "../electron/store/store";
import { deviceTrustMessage } from "../shared/remote-devices";
import type { Conversation } from "../shared/types";

const owner = "account-a";
const device = "computer-a";
const client = { client_id: randomUUID() };
const presencePath = (id: string) =>
  `/v1/code/sessions/cse_${id.replaceAll("-", "")}/client/presence`;

function fixture() {
  const conversation: Conversation = {
    id: randomUUID(),
    mode: "code",
    title: "Code session",
    providerId: "provider",
    model: "model",
    pinned: false,
    archived: false,
    unread: true,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    sessionAuthors: { ownerAccountUuid: owner, viewerAccountUuid: owner },
  };
  const unrelated = () => assert.fail("Viewer requests affect only leases");
  const stored = [conversation];
  const conversations = () => stored;
  const officialCode = createOfficialRemoteCodeHost({
    account: () => ({ id: owner, name: "Owner", email: "owner@example.test" }),
    device: unrelated,
    settings: () => defaultSettings,
    directory: unrelated,
    viewerScope: conversations,
    conversations,
    approvals: unrelated,
    modelCatalog: unrelated,
    codeUltracodeAvailable: unrelated,
    assertFolder: unrelated,
    create: unrelated,
    send: unrelated,
    update: unrelated,
    delete: unrelated,
    saveCodeFlags: unrelated,
    interrupt: unrelated,
    approve: unrelated,
  });
  const methods = new DeviceMethods({
    officialCode,
    conversations,
    approvals: unrelated,
    send: unrelated,
    interrupt: unrelated,
    approve: unrelated,
    remoteFolders: unrelated,
    models: unrelated,
    update: unrelated,
    now: Date.now,
  });
  const path = presencePath(conversation.id);
  return {
    conversation,
    methods,
    path,
    request: (body: unknown) => ({ method: "POST", path, body }),
  };
}

test("a signed device registers, renews, and clears a Code viewer", async (t) => {
  const { conversation, methods, request } = fixture();
  const original = structuredClone(conversation);
  const directory = mkdtempSync(join(tmpdir(), "official-code-viewer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trust = new DeviceTrustStore(directory, owner, device);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const identity = {
    name: "Viewer",
    platform: "web",
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const envelope = (method: string, args: unknown[]) => {
    const challenge = trust.challenge(identity);
    const signature = sign(
      null,
      Buffer.from(deviceTrustMessage(challenge, method, args)),
      privateKey,
    ).toString("base64");
    return { args, deviceTrust: { challengeId: challenge.id, signature } };
  };
  trust.setRequired(true);
  trust.enroll(envelope("deviceTrustEnroll", []));
  const [pending] = trust.state().pending;
  trust.approve(pending.id, pending.fingerprint);

  const call = (body: unknown) => {
    const method = "officialCode";
    const args = trust.authorize(method, [envelope(method, [request(body)])]);
    const revision = trust.accessRevision;
    return methods.call(method, args, () => trust.accessRevision === revision);
  };
  const accepted = { status: 200, value: { refresh_after_seconds: 20 } };
  assert.deepEqual(await call(client), accepted);
  assert.deepEqual(await call(client), accepted);
  assert.deepEqual(await call({ ...client, clear: true }), accepted);
  assert.deepEqual(await call({ ...client, clear: true }), accepted);
  assert.deepEqual(conversation, original);

  trust.revoke(pending.id);
  assert.throws(() => call(client), /access was revoked/);
});

test("the device viewer route requires a current call, an owned session, and a valid body", async () => {
  const { conversation, methods, path, request } = fixture();
  const call = (
    body: unknown,
    overrides?: { path?: string; method?: string },
  ) => methods.call("officialCode", [{ ...request(body), ...overrides }]);
  for (const body of [
    undefined,
    { client_id: "viewer" },
    { ...client, clear: false },
    { ...client, extra: 1 },
  ])
    assert.partialDeepStrictEqual(await call(body), { status: 400 });
  for (const overrides of [
    { path: presencePath(randomUUID()) },
    { path: path + "?extra=1" },
    { path: path.replace("/cse_", "/session_") },
    { method: "GET" },
  ])
    assert.partialDeepStrictEqual(await call(client, overrides), {
      status: 404,
    });
  assert.partialDeepStrictEqual(
    await methods.call("officialCode", [request(client)], () => false),
    { status: 403 },
  );
  conversation.sessionAuthors = {
    ownerAccountUuid: "account-b",
    viewerAccountUuid: owner,
  };
  assert.partialDeepStrictEqual(await call(client), { status: 404 });
  assert.partialDeepStrictEqual(await call({ ...client, clear: true }), {
    status: 404,
  });
});
