import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SendInput } from "../../electron/engine/new-conversation";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { openPolicy } from "../../shared/client-policy";
import type { Conversation } from "../../shared/types";
import { encodeWireValue } from "../../shared/web-wire";
import {
  negotiatedOfficialAction,
  readOfficialCapabilities,
} from "../../src-web/official/negotiated-action";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

test(
  "queued inputs saved by the previous Runner survive integration, replay, and cancellation",
  { timeout: 30_000 },
  async (t) => {
    useElectronShim();
    const [
      { registerConversationTurnHandlers },
      { storeOfficialAttachments },
      { CloudStore },
      { run, newSession, resumedSetup },
    ] = await Promise.all([
      import("../../electron/ipc/conversation-turn-handlers"),
      import("../../electron/ipc/official-attachments"),
      import("../../runner/src/cloud-store"),
      import("../../runner/src/dispatcher-sessions"),
    ]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-code-write-"));
    const user = { id: 1, accessToken: "fixture-token" };
    const account = { id: "fixture-owner" };
    const org = organizationUuid(account.id);
    const web = memoryWebstore();
    const open = (name: string) =>
      CloudStore.open({
        root: path.join(root, name),
        userId: user.id,
        transport: web,
      });
    const original: Conversation = {
      id: "existing-code-session",
      mode: "code",
      title: "Existing Code session",
      model: "code-model",
      providerId: "fixture-provider",
      updatedAt: 1,
      createdAt: 1,
      pinned: false,
      archived: false,
      turns: [],
    };
    const sent: string[] = [];
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ctx = {
      userId: user.id,
      activeAccount: account,
      accountActivationIdentity: {},
      accountRetiring: false,
      officialSessionIdentity() {
        return this.accountActivationIdentity;
      },
      store: await open("before-restart"),
      engine: {
        async send(input: SendInput) {
          const eventId = input.officialCodeEventId;
          assert.ok(
            eventId,
            "only the trusted Runner dispatch carries the UUID",
          );
          assert.equal(input.providerId, original.providerId);
          assert.equal(input.mode, "code");
          const conversation = ctx.store.conversation(input.conversationId!);
          assert.equal(input.model, conversation.model);
          sent.push(eventId);
          conversation.turns.push({
            id: "runtime-" + eventId,
            officialCodeEventId: eventId,
            officialCodeInputHash: input.officialCodeInputHash,
            prompt: input.text,
            attachments: input.attachments,
            items: [
              { type: "agentMessage", id: eventId, text: "fixture reply" },
            ],
            status: "completed",
            createdAt: sent.length + 1,
          });
          ctx.store.flush();
          return structuredClone(conversation);
        },
      },
      engineFor() {
        return this.engine;
      },
      push() {},
      handlers,
      engineRunning: () => true,
      selectedAttachments: new Map(),
      policy: () => openPolicy,
      allowedFolder() {},
      services: {},
      closedFlag: false,
      signedOut: false,
      setAccessToken() {},
      onEvent: () => () => {},
      onAccountDeactivating: () => () => {},
      appVersion: "fixture",
      log() {},
    };
    t.after(async () => {
      await ctx.store.close();
      await new Promise((resolve) => setTimeout(resolve, 550));
      fs.rmSync(root, { recursive: true, force: true });
    });
    ctx.store.conversations.push(original);
    ctx.store.settings.providers = [
      {
        id: original.providerId,
        name: "Fixture",
        baseUrl: "https://fixture.invalid/v1",
        model: original.model,
        models: [original.model, "no-effort-model"],
        protocol: "responses",
      },
    ];
    await ctx.store.sync();
    registerConversationTurnHandlers({
      context: ctx,
      handle: (method: string, handler: (...args: any[]) => unknown) =>
        handlers.set(method, handler),
    } as never);
    handlers.set("snapshot", () => ({
      conversations: ctx.store.conversations,
    }));
    handlers.set("conversationTurns", () => ({
      turns: ctx.store.conversation(original.id).turns,
    }));
    handlers.set("listSlashCommands", ({ conversationId }) => {
      assert.equal(conversationId, original.id);
      return {
        commands: [
          {
            name: "fixture-check",
            description: "Check the fixture",
            source: "prompt",
          },
        ],
        usageCredits: false,
      };
    });
    handlers.set("readCustomPrompt", (name) => {
      assert.equal(name, "fixture-check");
      return "Inspect $1 in $TARGET.";
    });
    handlers.set("modelCatalog", () => ({
      items: [
        {
          id: original.model,
          efforts: ["low", "medium", "high", "xhigh", "max"],
          defaultEffort: "high",
        },
        { id: "no-effort-model" },
      ],
    }));
    handlers.set(
      "addAttachmentData",
      (name, data) =>
        storeOfficialAttachments(ctx as never, [{ name, data }])[0],
    );
    handlers.set("turnAttachment", (conversationId, id) => {
      const owned = ctx.store
        .conversation(conversationId)
        .turns.flatMap((turn) => turn.attachments)
        .find((attachment) => attachment.id === id);
      return owned ? { data: fs.readFileSync(owned.path) } : null;
    });
    const dispatcher = {
      options: {
        officialUiRoot: "/fixture-assets",
        officialUiActions: true,
        link: web,
      },
      guard: { modes: ["chat", "code"] },
      methods: [
        "send",
        "snapshot",
        "conversationTurns",
        "addAttachmentData",
        "turnAttachment",
        "modelCatalog",
        "listSlashCommands",
        "readCustomPrompt",
      ],
      contextFor: async () => ctx,
      context: () => ctx,
      now: () => 1,
      run,
      newSession,
      resumedSetup,
    } as unknown as Dispatcher;
    const call = (method: string, request: OfficialUiReadRequest) =>
      dispatcher.run({
        method,
        user,
        args: encodeWireValue([request]),
      } as CallFrame) as Promise<OfficialUiReadResponse>;
    const read = (request: OfficialUiReadRequest) =>
      call("officialUiRead", request);
    const action = (request: OfficialUiReadRequest) =>
      call("officialUiAction", request);
    const fetch = createOfficialReadFetch(
      "https://fixture.invalid",
      read,
      async () => assert.fail("Code request escaped the local bridge"),
      () => () => {},
      negotiatedOfficialAction({
        mode: "engine-chat",
        accountId: String(user.id),
        isCurrent: () => true,
        read,
        action,
      }),
    );
    const key = cloudCodeSessionKey(original, account.id);
    const v2 = "/v1/code/sessions/cse_" + key + "/events";
    const sessionPath = "/v1/code/sessions/session_" + key;
    const manage = (
      method: string,
      suffix = "",
      body: unknown = {},
      organization = org,
    ) =>
      fetch(sessionPath + suffix, {
        method,
        headers: {
          "x-organization-uuid": organization,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const event = (uuid: string, text: string, alias: string) => ({
      type: "user",
      uuid,
      session_id: alias + key,
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text }] },
    });
    const post = (url: string, body: unknown, organization = org) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-organization-uuid": organization,
        },
        body: JSON.stringify(body),
      });
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOQT75LEmIY1TCqYfhqAADceF8Qtr3WKQAAAABJRU5ErkJggg==";
    const imageEvent = (data: string, alias = "cse_") => ({
      ...event("bca31210-f532-4dd3-aa37-8e06c9c371e5", "image prompt", alias),
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data },
          },
          { type: "text", text: "image prompt" },
        ],
      },
    });
    const { readCodeQueue } =
      await import("../../runner/src/official-code-queue");
    let queueSession = ctx.store.conversation(original.id);
    const active = {
      id: "queue-active",
      prompt: "running",
      attachments: [],
      items: [],
      status: "inProgress" as const,
      createdAt: Date.now(),
    };
    queueSession.turns.push(active);
    const canonicalId = "90f53404-b899-45e9-8749-3b1039211f7e";
    const queueEvent = (uuid: string) => ({
      events: [{ payload: { ...imageEvent(png), uuid, priority: "later" } }],
    });
    assert.equal((await post(v2, queueEvent(canonicalId))).status, 200);
    const canonical = readCodeQueue(
      ctx.store.root,
      account.id,
      queueSession,
    ).find((entry) => entry.eventId === canonicalId);
    assert.equal(canonical?.state, "queued");
    assert.equal(
      canonical?.attachments[0].sha256,
      createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"),
    );
    await post(v2, {
      events: [
        {
          payload: {
            type: "control_request",
            request_id: "cancel_async_message-test",
            request: {
              subtype: "cancel_async_message",
              message_uuid: canonicalId,
            },
          },
        },
      ],
    });
    assert.equal(
      readCodeQueue(ctx.store.root, account.id, queueSession).some(
        (entry) => entry.eventId === canonicalId,
      ),
      false,
    );
    active.status = "completed" as typeof active.status;
    await ctx.store.close();
    ctx.store = await open("before-legacy-queue");
    ctx.accountActivationIdentity = {};
    queueSession = ctx.store.conversation(original.id);
    const queuedIds = [
      "de2fd0c9-61c8-4a21-af44-3d6e94012912",
      "0a590164-55b9-4d27-a23c-97f65a5e9b0e",
    ];
    const legacyBytes = Buffer.from(png, "base64");
    const digest = createHash("sha256").update(legacyBytes).digest("hex");
    const legacyHash = createHash("sha256")
      .update(
        JSON.stringify(["image prompt", [["image-1.png", digest]], "later"]),
      )
      .digest("hex");
    queueSession.officialCodeQueuedTurns = queuedIds.map((eventId, index) => {
      const id = index
        ? "a62fa032-02b5-4905-bfc0-d16780118d5f"
        : "971c449a-c397-4bc8-9a2b-bfb95b1e5c01";
      const dir = path.join(ctx.store.root, "attachments", id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "image.png");
      fs.writeFileSync(file, legacyBytes);
      return {
        id: `queued-${id}`,
        officialCodeEventId: eventId,
        officialCodeInputHash: legacyHash,
        officialCodeAttachmentHashes: [digest],
        officialCodeQueueSequence: index + 1,
        officialCodeQueuePriority: "later" as const,
        queueState: "queued" as const,
        prompt: "image prompt",
        attachments: [
          {
            id,
            name: "image.png",
            path: file,
            kind: "image" as const,
            size: legacyBytes.length,
          },
        ],
        items: [],
        status: "inProgress" as const,
        createdAt: Date.now() + index,
      };
    });
    for (const id of queuedIds)
      await ctx.store.confirmOfficialCodeQueue(queueSession, id, () => true);
    const legacyRoot = ctx.store.root;
    await ctx.store.close();
    ctx.store = await open("legacy-queue-restart");
    fs.cpSync(
      path.join(legacyRoot, "attachments"),
      path.join(ctx.store.root, "attachments"),
      { recursive: true },
    );
    ctx.accountActivationIdentity = {};
    queueSession = ctx.store.conversation(original.id);
    for (const turn of queueSession.officialCodeQueuedTurns!) {
      for (const attachment of turn.attachments)
        attachment.path = path.join(
          ctx.store.root,
          "attachments",
          attachment.id,
          attachment.name,
        );
      await ctx.store.confirmOfficialCodeQueue(
        queueSession,
        turn.officialCodeEventId!,
        () => true,
      );
    }
    const secondFile =
      queueSession.officialCodeQueuedTurns![1].attachments[0].path;
    const changed = Buffer.from(legacyBytes);
    changed[changed.length - 1] ^= 1;
    fs.writeFileSync(secondFile, changed);
    const history = async () =>
      (await (await fetch(v2)).json()).data as {
        sequence_num: number;
        event_id: string;
        processing_at?: string;
        payload: { uuid: string; priority?: string };
      }[];
    const before = (await history()).find(
      (row) => row.payload.uuid === queuedIds[1],
    );
    assert.ok(before);
    assert.equal(before.payload.priority, "later");
    assert.equal(before.processing_at, undefined);
    assert.equal((await post(v2, queueEvent(queuedIds[1]))).status, 200);
    await fetch(v2);
    const firstDeadline = Date.now() + 5000;
    while (!sent.includes(queuedIds[0]) && Date.now() < firstDeadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(sent.includes(queuedIds[0]));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(
      !sent.includes(queuedIds[1]),
      "changed legacy attachment bytes must not be dispatched",
    );
    const later = (await history()).find(
      (row) => row.payload.uuid === queuedIds[1],
    );
    assert.equal(later?.event_id, before.event_id);
    assert.equal(later?.sequence_num, before.sequence_num);
    fs.writeFileSync(secondFile, legacyBytes);
    await fetch(v2);
    const deadline = Date.now() + 5000;
    while (!sent.includes(queuedIds[1]) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      sent.filter((id) => queuedIds.includes(id)),
      queuedIds,
    );
    assert.equal((await post(v2, queueEvent(queuedIds[1]))).status, 200);
    await ctx.store.settled();
    assert.deepEqual(queueSession.officialCodeQueuedTurns ?? [], []);
    const cancelledLegacyId = "ce49b2b9-9f88-48a8-a68e-1f61dc515c4e";
    queueSession.officialCodeQueuedTurns = [
      {
        id: "legacy-missing-attachment",
        officialCodeEventId: cancelledLegacyId,
        queueState: "queued",
        prompt: "queued",
        attachments: [],
        items: [],
        status: "inProgress",
        createdAt: Date.now(),
      },
    ];
    await ctx.store.confirmOfficialCodeQueue(
      queueSession,
      cancelledLegacyId,
      () => true,
    );
    assert.equal((await manage("POST", "/archive")).status, 409);
    const cancel = () =>
      post(v2, {
        events: [
          {
            payload: {
              type: "control_request",
              request_id: "cancel_async_message-legacy",
              request: {
                subtype: "cancel_async_message",
                message_uuid: cancelledLegacyId,
              },
            },
          },
        ],
      });
    assert.equal((await (await cancel()).json()).cancelled, true);
    await ctx.store.close();
    ctx.store = await open("cancel-legacy-restart");
    ctx.accountActivationIdentity = {};
    queueSession = ctx.store.conversation(original.id);
    assert.equal(
      queueSession.officialCodeQueuedTurns?.[0].queueState,
      "cancelled",
    );
    assert.equal((await (await cancel()).json()).cancelled, true);
    assert.ok(!sent.includes(cancelledLegacyId));
  },
);
