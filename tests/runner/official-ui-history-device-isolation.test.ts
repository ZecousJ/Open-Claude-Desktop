import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { registryFor } from "../../electron/official-ui/api/timeline";
import { ReplyFeedback } from "../../electron/conversations/reply-feedback";
import { openPolicy } from "../../shared/client-policy";
import {
  officialUiRecentsPath,
  officialUiTimelinePath,
  type OfficialUiWireRequest,
} from "../../shared/official-ui-web";
import type { Conversation } from "../../shared/types";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";
import type { CallFrame } from "../../runner/src/dispatcher";
import { useElectronShim } from "./runner-core-support.test";

useElectronShim();
const { ChatDeviceController } = await import("../../runner/src/chat-devices");
const { CloudStore } = await import("../../runner/src/cloud-store");
const { officialUiRead } = await import("../../runner/src/official-ui-read");
const { registerCoreHandlers } =
  await import("../../runner/src/web-context-settings");

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "official Chat history remains available while a different conversation's computer is unresponsive",
  { timeout: 3000 },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "claudex-official-history-"),
    );
    const build = path.resolve("build/official-ui");
    const owner = "cloud-account";
    const org = organizationUuid(owner);
    const user = { id: 7, accessToken: "fixture-inert" };
    const accountScope = String(user.id);
    const store = new CloudStore({
      root,
      userId: user.id,
      transport: {
        request: async () => {
          throw Error("Unexpected cloud store request");
        },
      },
    });
    const cloud: Conversation = {
      id: "11111111-1111-4111-8111-111111111111",
      mode: "chat",
      title: "Cloud chat",
      model: "fixture",
      providerId: "fixture",
      createdAt: 1,
      updatedAt: 2,
      pinned: false,
      archived: false,
      turns: [
        {
          id: "first",
          prompt: "Stored question",
          attachments: [],
          status: "completed",
          createdAt: 1,
          items: [
            { id: "answer", type: "agentMessage", text: "Stored answer" },
          ],
        },
      ],
      savedBranches: [
        {
          id: "earlier",
          providerId: "fixture",
          model: "fixture",
          visited: 1,
          turns: [
            {
              id: "older",
              prompt: "Earlier question",
              attachments: [],
              status: "completed",
              createdAt: 1,
              items: [
                {
                  id: "earlier-answer",
                  type: "agentMessage",
                  text: "Earlier answer",
                },
              ],
            },
          ],
        },
      ],
    };
    const remoteId = "bound-on-computer";
    const bound: Conversation = {
      ...cloud,
      id: "22222222-2222-4222-8222-222222222222",
      title: "Bound chat",
      savedBranches: undefined,
      chatDeviceBinding: {
        version: 1,
        accountScope,
        organizationId: null,
        deviceId: "computer",
        remoteConversationId: remoteId,
        revision: 1,
        permission: "default",
      },
    };
    store.conversations = [cloud, bound];
    const entered = deferred();
    const release = deferred();
    let remotePrompt = "Updated during snapshot refresh";
    const device = new ChatDeviceController({
      root,
      accountScope,
      current: () => true,
      conversations: () => store.conversations,
      settings: () => store.settings,
      attachment: () => undefined,
      async save(conversation) {
        store.conversations = store.conversations.map((c) =>
          c.id === conversation.id ? conversation : c,
        );
      },
      async request(op, body) {
        if (op === "device.list")
          return {
            version: 1,
            accountScope,
            organizationId: null,
            devices: [],
          };
        assert.ok(
          body &&
            typeof body === "object" &&
            "method" in body &&
            body.method === "chatDeviceOpen",
        );
        entered.resolve();
        await release.promise;
        return {
          conversation: {
            ...cloud,
            id: remoteId,
            savedBranches: undefined,
            turns: [{ ...cloud.turns[0], prompt: remotePrompt }],
            deviceChatOrigin: {
              version: 1,
              accountScope,
              logicalConversationId: bound.id,
              active: true,
              permission: "default",
            },
          },
          approvals: [],
        };
      },
      push() {},
      async release() {},
    });
    t.after(() => {
      device.dispose();
      release.resolve();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const identity = {};
    const ctx = {
      userId: user.id,
      activeAccount: {
        id: owner,
        name: "Fixture",
        email: "fixture@example.invalid",
      },
      store,
      handlers,
      chatDeviceController: device,
      replyFeedback: new ReplyFeedback(root),
      engine: { approvals: [] },
      officialSessionIdentity: () => identity,
      snapshot: () => ({
        conversations: store.conversations,
        projects: store.projects,
        approvals: [],
      }),
      policy: () => openPolicy,
      onEvent: () => () => {},
      setAccessToken() {},
      appVersion: "test",
      log() {},
    };
    registerCoreHandlers.call(ctx as never, (method, handler) => {
      handlers.set(method, handler);
    });
    const dispatcher = {
      options: { officialUiRoot: build },
      guard: { modes: ["chat"] },
      context: () => ctx,
      contextFor: async () => ctx,
      now: () => 0,
      async run(frame: CallFrame) {
        const handler = handlers.get(frame.method);
        assert.ok(handler, `Unexpected dispatch: ${frame.method}`);
        const args = decodeWireValue(frame.args);
        assert.ok(Array.isArray(args));
        return handler(...args);
      },
    };
    const read = async (request: OfficialUiWireRequest) =>
      officialUiRead(dispatcher as never, {
        t: "call",
        id: "history",
        method: "officialUiRead",
        deadlineMs: Date.now() + 30_000,
        user,
        args: [encodeWireValue(request)],
      });
    const snapshot = handlers.get("snapshot");
    assert.ok(snapshot);
    const refreshing = Promise.resolve(snapshot());
    await entered.promise;

    const schema = registryFor(build).getMessage(
      "anthropic.bard.api.v1alpha.StreamTimelineRequest",
    );
    assert.ok(schema);
    const message = toBinary(
      schema,
      create(schema, { conversationId: cloud.id }),
    );
    const envelope = Buffer.alloc(5);
    envelope.writeUInt32BE(message.length, 1);
    const base = `/api/organizations/${org}/chat_conversations`;
    const recents = Buffer.from(
      JSON.stringify({ organizationUuid: org, first: { surfaces: [1] } }),
    );
    const [list, detail, timeline, recent, missing, foreign] =
      await Promise.all([
        read({ method: "GET", path: base + "_v2" }),
        read({ method: "GET", path: `${base}/${cloud.id}` }),
        read({
          method: "POST",
          path: officialUiTimelinePath,
          contentType: "application/connect+proto",
          body: Buffer.concat([envelope, message]),
        }),
        read({
          method: "POST",
          path: officialUiRecentsPath,
          contentType: "application/json",
          body: recents,
        }),
        read({
          method: "GET",
          path: `${base}/33333333-3333-4333-8333-333333333333`,
        }),
        read({
          method: "GET",
          path: `${base.replace(org, organizationUuid("other"))}/${cloud.id}`,
        }),
      ]);
    for (const response of [list, detail, timeline, recent])
      assert.equal(response.status, 200);
    for (const response of [missing, foreign])
      assert.equal(response.status, 404);
    const listBody = Buffer.from(list.body).toString();
    assert.match(listBody, /Cloud chat/);
    assert.match(listBody, /Bound chat/);
    const history = Buffer.from(detail.body).toString();
    assert.match(history, /Stored answer/);
    assert.match(history, /Earlier answer/);
    assert.match(Buffer.from(timeline.body).toString(), /Stored answer/);
    assert.match(Buffer.from(recent.body).toString(), /Cloud chat/);

    release.resolve();
    await refreshing;
    remotePrompt = "Updated on the computer";
    const updated = await read({ method: "GET", path: `${base}/${bound.id}` });
    assert.equal(updated.status, 200);
    assert.match(
      Buffer.from(updated.body).toString(),
      /Updated on the computer/,
    );
  },
);
