import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppEvent, Conversation } from "../../shared/types";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { encodeWireValue } from "../../shared/web-wire";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

test("Cloud Code read saves the observed activity and publishes metadata only after acknowledgement", async (t) => {
  useElectronShim();
  const [
    { CloudStore },
    { officialUiRead },
    { cloudCodeSessionKey },
    { organizationUuid },
  ] = await Promise.all([
    import("../../runner/src/cloud-store"),
    import("../../runner/src/official-ui-read"),
    import("../../electron/official-ui/api/cloud-code-history"),
    import("../../electron/official-ui/api/context"),
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-code-read-"));
  const user = { id: 1, accessToken: "fixture-token" };
  const web = memoryWebstore();
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let releaseWrite!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let holdWrite = false;
  const transport = {
    async request(op: string, userId: number, body?: unknown) {
      if (holdWrite && op === "store.conversations.put") {
        holdWrite = false;
        signalEntered();
        await released;
      }
      return web.request(op, userId, body);
    },
  };
  const open = (profile: string) =>
    CloudStore.open({
      root: path.join(root, profile),
      userId: user.id,
      transport,
      log() {},
    });
  const store = await open("profile");
  t.after(async () => {
    releaseWrite();
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const conversation: Conversation = {
    id: "existing-code",
    mode: "code",
    title: "Cloud Code",
    providerId: "fixture",
    model: "fixture",
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: false,
    unread: true,
    readStateRevision: 3,
    turns: [
      {
        id: "completed",
        prompt: "Fixture prompt",
        status: "completed",
        createdAt: 2,
        attachments: [],
        items: [{ id: "answer", type: "agentMessage", text: "Fixture answer" }],
      },
    ],
  };
  store.conversations.push(conversation);
  await store.sync();
  const account = { id: "owner" };
  const organization = organizationUuid(account.id);
  const key = cloudCodeSessionKey(conversation, account.id);
  const identity = {};
  const events: AppEvent[] = [];
  const ctx = {
    userId: user.id,
    activeAccount: account,
    store,
    selectedAttachments: new Map(),
    officialSessionIdentity: () => identity,
    setAccessToken() {},
    push(event: AppEvent) {
      events.push(event);
    },
  };
  const dispatcher = {
    options: { officialUiRoot: "/fixture", officialUiActions: true },
    guard: { modes: ["chat", "code"] },
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 1,
  } as unknown as Dispatcher;
  const call = (method: string, request: OfficialUiReadRequest) =>
    officialUiRead(dispatcher, {
      method,
      user,
      args: encodeWireValue([request]),
    } as CallFrame) as Promise<OfficialUiReadResponse>;
  const read = await call("officialUiRead", {
    method: "GET",
    path: "/api/claudex/official-capabilities/version1",
  });
  const lease: string = JSON.parse(
    new TextDecoder().decode(read.body),
  ).activationLease;
  const mark = (body: unknown, revision: number, org = organization) =>
    call("officialUiAction", {
      method: "POST",
      path: `/v1/code/sessions/cse_${key}/mark_read`,
      body: new TextEncoder().encode(JSON.stringify(body)),
      contentType: "application/json",
      capabilityLease: lease,
      codeOrganizationId: org,
      codeReadRevision: revision,
    });
  const start = web.log.length;
  assert.equal((await mark({ event_id: "old-result" }, 3)).status, 409);
  assert.equal((await mark({ event_id: "completed:result" }, 2)).status, 409);
  assert.equal(
    (await mark({ event_id: "completed:result", unread: true }, 3)).status,
    400,
  );
  assert.equal((await mark({}, 3, organizationUuid("other"))).status, 404);
  assert.equal(web.log.length, start);
  assert.deepEqual(events, []);

  holdWrite = true;
  const saving = mark({ event_id: "completed:result" }, 3);
  await entered;
  assert.deepEqual(events, []);
  conversation.unread = true;
  conversation.readStateRevision = 5;
  store.flush();
  releaseWrite();
  assert.equal((await saving).status, 409);
  await store.settled();
  assert.equal(conversation.unread, true);
  assert.deepEqual(events, []);

  const beforeRead = web.log.length;
  assert.equal((await mark({ event_id: "completed:result" }, 5)).status, 200);
  assert.equal((await mark({ event_id: "completed:result" }, 5)).status, 200);
  assert.deepEqual(events, [
    {
      type: "code-read-state",
      conversationId: conversation.id,
      unread: false,
      readStateRevision: 6,
    },
  ]);
  assert.deepEqual(
    web.log.slice(beforeRead).map(({ op }) => op),
    ["store.conversations.put"],
  );
  const reopened = await open("reopened");
  try {
    const saved = reopened.conversation(conversation.id);
    assert.equal(saved.unread, false);
    assert.equal(saved.readStateRevision, 6);
    assert.deepEqual(saved.turns, conversation.turns);
  } finally {
    await reopened.close();
  }
});
