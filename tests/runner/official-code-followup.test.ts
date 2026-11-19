import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SendInput } from "../../electron/engine/new-conversation";
import type { Engine } from "../../electron/engine/engine";
import {
  CodeRunAdmissionError,
  CodeSendCancelled,
  CodeSendStart,
  trackCodeSendStart,
} from "../../electron/engine/code-send-start";
import type { OfficialCodeSteer } from "../../shared/official-code-followup";
import { cloudCodeEventId, cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { lockedPolicy, openPolicy } from "../../shared/client-policy";
import { newSessionSetup } from "../../shared/session-setup";
import { webErrorCodes } from "../../shared/web-protocol";
import type {
  AppEvent,
  Attachment,
  Conversation,
  Turn,
} from "../../shared/types";
import { encodeWireValue } from "../../shared/web-wire";
import {
  negotiatedOfficialAction,
  readOfficialCapabilities,
} from "../../src-web/official/negotiated-action";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "original Web Code follow-ups persist once across both formats and Runner restart",
  { timeout: 30_000 },
  async (t) => {
    useElectronShim();
    const [
      { registerConversationTurnHandlers },
      { storeOfficialAttachments },
      { CloudStore },
      { run, newSession, resumedSetup },
      { officialCodeQueueInputs, nativeCodeQueueMethods },
      { queuedCodeAttachmentIds },
      { pruneAttachments, attachmentRetentionMs },
      { fetchForSetup },
      { Engine },
    ] = await Promise.all([
      import("../../electron/ipc/conversation-turn-handlers"),
      import("../../electron/ipc/official-attachments"),
      import("../../runner/src/cloud-store"),
      import("../../runner/src/dispatcher-sessions"),
      import("../../runner/src/official-code-followup"),
      import("../../runner/src/official-code-queue"),
      import("../../runner/src/attachments"),
      import("../../electron/engine/engine-send"),
      import("../../electron/engine/engine"),
    ]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-code-write-"));
    const user = { id: 1, accessToken: "fixture-token" };
    const account = { id: "fixture-owner" };
    const org = organizationUuid(account.id);
    const web = memoryWebstore();
    let failTurnWrite = false;
    let heldStopWrite:
      | {
          entered: ReturnType<typeof signal>;
          release: ReturnType<typeof signal>;
        }
      | undefined;
    const transport = {
      request(op: string, userId: number, body?: unknown) {
        if (failTurnWrite && op === "store.turns.put")
          return Promise.reject(Error("Fixture storage unavailable"));
        if (heldStopWrite && op === "store.turns.put") {
          heldStopWrite.entered.resolve();
          return heldStopWrite.release.promise.then(() =>
            web.request(op, userId, body),
          );
        }
        return web.request(op, userId, body);
      },
    };
    const open = (name: string) =>
      CloudStore.open({
        root: path.join(root, name),
        userId: user.id,
        transport,
      });
    const original: Conversation = {
      id: "existing-code-session",
      mode: "code",
      threadId: "fixture-thread",
      title: "Existing Code session",
      model: "code-model",
      providerId: "fixture-provider",
      updatedAt: 1,
      createdAt: 1,
      pinned: false,
      archived: false,
      turns: [],
    };
    const firstId = "b5427249-f9fc-450e-8f4e-0be76af3c41a";
    const secondId = "42df3c6c-31a5-49d5-97f4-a34cc6d35bcb";
    const firstUltracodeId = randomUUID();
    const firstSend = signal();
    const releaseSend = signal();
    const sent: string[] = [];
    const sentModels = new Map<string, Pick<SendInput, "model" | "effort">>();
    const steered: string[] = [];
    const listeners = new Set<(event: AppEvent) => void>();
    const observedSends = new Map<string, () => void>();
    let stopCount = 0;
    let stopBehavior: ((turn: Turn) => Promise<void>) | undefined;
    let loseSteerReply = false;
    let missSteerTurn = false;
    let deferSteerRecord: string | undefined;
    let ambiguousSend:
      | {
          eventId: string;
          started: ReturnType<typeof signal>;
          release: ReturnType<typeof signal>;
        }
      | undefined;
    let startingSend:
      | {
          eventId: string;
          shown: ReturnType<typeof signal>;
          resume: ReturnType<typeof signal>;
        }
      | undefined;
    let beforeEngine:
      | {
          entered: ReturnType<typeof signal>;
          resume: ReturnType<typeof signal>;
        }
      | undefined;
    const cloneGates = new Map<string, {
      entered: ReturnType<typeof signal>;
      finish: ReturnType<typeof signal>;
      error?: string;
      admissionError?: string;
    }>();
    const sentSkills = new Map<string, SendInput["skillReferences"]>();
    const emit = (event: AppEvent) => {
      for (const listener of [...listeners]) listener(event);
    };
    let attachmentsAllowed = true;
    let ultracodeAllowed = false;
    const handlers = new Map<string, (...args: any[]) => unknown>();
    handlers.set("modelCatalog", () => ({ items: [
      { id: original.model, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
      { id: "no-effort-model", efforts: [] },
      { id: "gpt-image-2.5", efforts: [] },
    ] }));
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
        get store() {
          return ctx.store;
        },
        setupAbort: undefined as Engine["setupAbort"],
        changed(conversation: Conversation) {
          ctx.store.flush();
          emit({ type: "conversation", conversation });
        },
        modelEfforts(_provider: string, model: string) {
          return model === "no-effort-model" ? [] : ["low", "medium", "high", "xhigh", "max"];
        },
        codeUltracodeAvailable(provider: string, model: string) {
          return ultracodeAllowed && this.modelEfforts(provider, model).includes("xhigh");
        },
        async codeUltracodeThreadAvailable() {
          return true;
        },
        async send(
          input: SendInput,
          _retryTurnId?: string,
          _editingPrompt?: boolean,
          options?: Parameters<Engine["send"]>[3],
        ) {
          if (options?.codeSendStart?.cancelledBeforeDispatch)
            throw new CodeSendCancelled();
          const eventId = input.officialCodeEventId;
          assert.ok(
            eventId,
            "only the trusted Runner dispatch carries the UUID",
          );
          assert.equal(input.providerId, original.providerId);
          assert.equal(input.model, ctx.store.conversation(input.conversationId!).model);
          assert.equal(input.mode, "code");
          const conversation = ctx.store.conversation(input.conversationId!);
          if (eventId === firstUltracodeId) {
            const saved = web.users.get(user.id)?.conversations.get(conversation.id)?.doc.conversation;
            assert.deepEqual(
              { mode: saved?.codeUltracode, effort: saved?.effort },
              { mode: true, effort: "medium" },
            );
          }
          sent.push(eventId);
          sentModels.set(eventId, { model: input.model, effort: input.effort });
          if (input.skillReferences?.length) sentSkills.set(eventId, input.skillReferences);
          if (eventId === firstId) {
            firstSend.resolve();
            await releaseSend.promise;
          }
          const setup = input.setup;
          if (setup?.repositories.length) {
            const admissionError = cloneGates.get(conversation.cwd!)?.admissionError;
            if (admissionError) {
              const engine = new Engine(ctx.store, "unused", () => "", emit);
              engine.policy = () => openPolicy;
              engine.ensure = async () => {};
              engine.windowsSandbox.ensureReady = async () => {};
              engine.rpc = {
                connected: true,
                async call(method: string) {
                  assert.notEqual(method, "turn/start");
                  return method === "thread/start" ? { thread: { id: "fixture-thread" } } : {};
                },
              } as Engine["rpc"];
              engine.admitCodeRun = async () => {
                throw new CodeRunAdmissionError(admissionError, webErrorCodes.capacity);
              };
              return engine.send(input, undefined, false, options).finally(() => observedSends.get(eventId)?.());
            }
            const start = options?.codeSendStart;
            assert.ok(start);
            const turn: Turn = {
              id: "pending-" + eventId,
              officialCodeEventId: eventId,
              officialCodeInputHash: input.officialCodeInputHash,
              prompt: input.text,
              attachments: input.attachments,
              items: [],
              status: "inProgress",
              createdAt: Date.now(),
              setup: newSessionSetup(setup.repositories.length),
            };
            start.bind(() => conversation.turns.at(-1) === turn, () => {
              this.setupAbort?.abort.abort();
              turn.status = "interrupted";
              turn.userStopped = true;
              this.changed(conversation);
            });
            conversation.turns.push(turn);
            trackCodeSendStart(conversation, turn, start);
            this.changed(conversation);
            if (!await fetchForSetup.call(this as unknown as Engine, conversation, setup)) {
              observedSends.get(eventId)?.();
              return structuredClone(conversation);
            }
            Object.assign(turn, {
              id: "runtime-" + eventId,
              status: "completed",
              items: [{ type: "agentMessage", id: eventId, text: "fixture reply" }],
            });
            this.changed(conversation);
            observedSends.get(eventId)?.();
            return structuredClone(conversation);
          }
          if (startingSend?.eventId === eventId) {
            const turn: Turn = {
              id: "pending-" + eventId,
              officialCodeEventId: eventId,
              prompt: input.text,
              attachments: input.attachments,
              items: [],
              status: "inProgress",
              createdAt: Date.now(),
            };
            const start = options?.codeSendStart ?? new CodeSendStart();
            start.bind(
              () => conversation.turns.at(-1) === turn,
              () => {
                turn.status = "interrupted";
                turn.userStopped = true;
                emit({ type: "conversation", conversation });
              },
            );
            conversation.turns.push(turn);
            trackCodeSendStart(conversation, turn, start);
            startingSend.shown.resolve();
            await startingSend.resume.promise;
            assert.ok(start.cancelledBeforeDispatch);
            throw new CodeSendCancelled();
          }
          if (ambiguousSend?.eventId === eventId) {
            conversation.turns.push({
              id: "pending-" + eventId,
              officialCodeEventId: eventId,
              prompt: input.text,
              attachments: input.attachments,
              items: [],
              status: "inProgress",
              createdAt: Date.now(),
            });
            await ctx.store.sync();
            ambiguousSend.started.resolve();
            await ambiguousSend.release.promise;
            throw Error("Fixture lost the Code dispatch outcome");
          }
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
          emit({ type: "conversation", conversation });
          observedSends.get(eventId)?.();
          return structuredClone(conversation);
        },
        async steerTurn(
          id: string,
          text: string,
          attachments: Attachment[],
          official: OfficialCodeSteer,
        ): ReturnType<Engine["steerTurn"]> {
          steered.push(official.eventId);
          if (loseSteerReply)
            throw new Error("Fixture lost the steer response");
          if (missSteerTurn) return null;
          const conversation = ctx.store.conversation(id);
          const messageId = "steer-" + randomUUID();
          if (official.eventId === deferSteerRecord)
            return { messageId, conversation };
          conversation.turns.at(-1)?.items.push({
            id: messageId,
            clientId: messageId,
            type: "userMessage",
            steered: true,
            lifecycleStatus: "completed",
            text,
            attachments,
            officialCodeEventId: official.eventId,
            officialCodeInputHash: official.inputHash,
          });
          emit({ type: "conversation", conversation });
          return { messageId, conversation };
        },
        async interrupt(id: string) {
          stopCount++;
          const conversation = ctx.store.conversation(id);
          const turn = conversation.turns.at(-1);
          assert.ok(turn);
          if (stopBehavior) return stopBehavior(turn);
          turn.status = "interrupted";
          turn.userStopped = true;
          emit({ type: "conversation", conversation });
        },
      },
      engineFor() {
        return this.engine;
      },
      handlers,
      push: emit,
      engineRunning: () => true,
      selectedAttachments: new Map(),
      refetchCodeSession(cwd: string) {
        const gate = cloneGates.get(cwd);
        assert.ok(gate);
        return async (signal: AbortSignal) => {
          gate.entered.resolve();
          await gate.finish.promise;
          signal.throwIfAborted();
          if (gate.error) throw Error(gate.error);
        };
      },
      policy: () => (attachmentsAllowed ? openPolicy : lockedPolicy),
      allowedFolder() {},
      services: {},
      closedFlag: false,
      signedOut: false,
      setAccessToken() {},
      onEvent(listener: (event: AppEvent) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      onAccountDeactivating: () => () => {},
      appVersion: "fixture",
      log() {},
    };
    t.after(async () => {
      releaseSend.resolve();
      failTurnWrite = false;
      await ctx.store.close();
      await new Promise((resolve) => setTimeout(resolve, 550));
      fs.rmSync(root, { recursive: true, force: true });
    });
    ctx.store.conversations.push(original);
    await ctx.store.sync();
    registerConversationTurnHandlers({
      context: ctx,
      handle: (method: string, handler: (...args: any[]) => unknown) =>
        handlers.set(method, handler),
    } as never);
    handlers.set("snapshot", () => ({
      conversations: ctx.store.conversations,
    }));
    handlers.set("conversationTurns", (id: string) => ({
      turns: ctx.store.conversation(id).turns,
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
        ...nativeCodeQueueMethods,
        "modelCatalog",
        "send",
        "snapshot",
        "conversationTurns",
        "addAttachmentData",
        "turnAttachment",
      ],
      contextFor: async (frame: CallFrame) => {
        if (frame.method === "send" && beforeEngine) {
          beforeEngine.entered.resolve();
          await beforeEngine.resume.promise;
        }
        return ctx;
      },
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
    const nativeQueue = (method: string, ...args: unknown[]) => dispatcher.run({
      t: "call", id: randomUUID(), method, user, args: encodeWireValue(args),
    } as CallFrame) as Promise<{ entries: import("../../shared/official-code-followup").OfficialCodeQueueInput[] }>;
    const fetch = createOfficialReadFetch(
      "https://fixture.invalid",
      read,
      async () => assert.fail("Code request escaped the local bridge"),
      (listener) => ctx.onEvent(listener),
      negotiatedOfficialAction({
        mode: "engine-chat",
        accountId: String(user.id),
        isCurrent: () => true,
        read,
        action,
      }),
    );
    const key = cloudCodeSessionKey(original, account.id);
    const legacy = "/v1/sessions/session_" + key + "/events";
    const v2 = "/v1/code/sessions/cse_" + key + "/events";
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
    const retry = (uuid: string, text: string) => ({
      events: [{ payload: event(uuid, text, "cse_"), user_declared_urls: [] }],
    });
    const legacyBody = { events: [event(firstId, "first", "session_")] };

    assert.equal(
      (await post(legacy, legacyBody, organizationUuid("other"))).status,
      404,
    );
    assert.equal(
      (await post(v2, { events: [{ payload: { type: "control_request" } }] }))
        .status,
      400,
    );
    assert.equal(
      (
        await action({
          method: "POST",
          path: legacy,
          contentType: "application/json",
          body: new TextEncoder().encode(JSON.stringify(legacyBody)),
        })
      ).status,
      409,
    );
    assert.deepEqual(sent, []);

    const first = post(legacy, legacyBody);
    const dispatchReached = await Promise.race([
      firstSend.promise.then(() => true),
      first.then(async (response) =>
        assert.fail(await response.clone().text()),
      ),
    ]);
    assert.equal(dispatchReached, true);
    assert.equal((await post(v2, retry(firstId, "first"))).status, 409);
    releaseSend.resolve();
    const accepted = await first;
    assert.equal(accepted.status, 200);
    const receipt = await accepted.json();
    const replay = await post(v2, retry(firstId, "first"));
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), receipt);
    assert.equal((await post(v2, retry(firstId, "different"))).status, 409);

    await ctx.store.close();
    ctx.store = await open("after-restart");
    ctx.accountActivationIdentity = {};
    const afterRestart = await post(v2, retry(firstId, "first"));
    assert.equal(afterRestart.status, 200);
    assert.deepEqual(await afterRestart.json(), receipt);
    const history = await fetch(v2, {
      headers: { "x-organization-uuid": org },
    });
    assert.equal(history.status, 200);
    const page = await history.json();
    const input = page.data.find(
      (row: { payload: { type: string } }) => row.payload.type === "user",
    );
    assert.equal(input.payload.uuid, firstId);
    assert.equal(input.event_id, receipt.events[0].event_id);
    assert.deepEqual(sent, [firstId]);

    failTurnWrite = true;
    assert.equal((await post(v2, retry(secondId, "second"))).status, 409);
    assert.equal((await post(v2, retry(secondId, "second"))).status, 409);
    assert.deepEqual(sent, [firstId, secondId]);
    failTurnWrite = false;
    assert.equal((await post(v2, retry(secondId, "second"))).status, 200);
    assert.deepEqual(sent, [firstId, secondId]);

    const imageId = "bca31210-f532-4dd3-aa37-8e06c9c371e5";
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOQT75LEmIY1TCqYfhqAADceF8Qtr3WKQAAAABJRU5ErkJggg==";
    const imageEvent = (data: string, alias = "cse_") => ({
      ...event(imageId, "image prompt", alias),
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
    const wrappedImage = (data: string) => ({
      events: [{ payload: imageEvent(data) }],
    });
    assert.equal((await post(v2, wrappedImage("aGVsbG8="))).status, 400);
    attachmentsAllowed = false;
    assert.equal((await post(v2, wrappedImage(png))).status, 400);
    attachmentsAllowed = true;

    const bytes = new TextEncoder().encode(JSON.stringify(wrappedImage(png)));
    const capability = await readOfficialCapabilities(read, String(user.id));
    web.files.set("fixture-code-image", { userId: user.id, bytes });
    const uploaded = await action({
      method: "POST",
      path: v2,
      codeOrganizationId: org,
      capabilityLease: capability.activationLease,
      contentType: "application/json",
      body: { $upload: "fixture-code-image" } as never,
    });
    assert.equal(uploaded.status, 200);
    const images = ctx.store
      .conversation(original.id)
      .turns.at(-1)!.attachments;
    assert.equal(images.length, 1);
    assert.equal(images[0].kind, "image");
    assert.equal(fs.readFileSync(images[0].path).toString("base64"), png);
    assert.deepEqual(sent, [firstId, secondId, imageId]);

    const restoredPage = await (
      await fetch(v2, { headers: { "x-organization-uuid": org } })
    ).json();
    const restored = restoredPage.data.find(
      (row: { payload: { uuid: string } }) => row.payload.uuid === imageId,
    );
    assert.deepEqual(
      restored.payload.message.content.find(
        (block: { type: string }) => block.type === "image",
      ),
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: png },
      },
    );
    const folder = path.join(ctx.store.root, "attachments");
    assert.equal(
      (await post(legacy, { events: [imageEvent(png, "session_")] })).status,
      200,
    );
    assert.deepEqual(fs.readdirSync(folder), [images[0].id]);

    // After a Runner moves, the saved content identity still guards the UUID.
    const altered = Buffer.from(png, "base64");
    altered[altered.length - 1] ^= 1;
    await ctx.store.close();
    ctx.store = await open("after-image-restart");
    ctx.accountActivationIdentity = {};
    assert.equal((await post(v2, wrappedImage(png))).status, 200);
    assert.equal(
      (await post(v2, wrappedImage(altered.toString("base64")))).status,
      409,
    );
    assert.equal((await post(v2, retry(imageId, "image prompt"))).status, 409);
    assert.deepEqual(sent, [firstId, secondId, imageId]);

    const documentText = "Exact bytes of an owned Web Code attachment.";
    const form = new FormData();
    form.set(
      "file",
      new Blob([documentText], { type: "text/plain" }),
      "owned.txt",
    );
    const uploadPath = "/api/" + org + "/upload?store_as_is=true";
    assert.equal(
      (
        await fetch(uploadPath.replace(org, organizationUuid("other")), {
          method: "POST",
          body: form,
        })
      ).status,
      404,
    );
    const upload = await fetch(uploadPath, { method: "POST", body: form });
    assert.equal(upload.status, 200, await upload.clone().text());
    const file = await upload.json();
    assert.equal(file.file_name, "owned.txt");
    assert.equal(file.path, "/owned.txt");
    const documentEventId = "ac9a84eb-d406-49d8-acef-d17578bc16d5";
    const document = (fileUuid: string) => ({
      events: [
        {
          payload: {
            ...event(documentEventId, "read the file", "cse_"),
            file_attachments: [
              {
                file_uuid: fileUuid,
                file_name: "owned.txt",
                mime_type: "text/plain",
                is_image: false,
              },
            ],
          },
        },
      ],
    });
    assert.equal(
      (await post(v2, document("f0282d8a-eb80-4c64-95b1-6d6b0de42163"))).status,
      400,
    );
    assert.equal((await post(v2, document(file.file_uuid))).status, 200);
    const documentHistory = await (await fetch(v2)).json();
    assert.deepEqual(
      documentHistory.data.find(
        (row: { payload: { uuid: string } }) =>
          row.payload.uuid === documentEventId,
      ).payload.file_attachments,
      [{ file_uuid: file.file_uuid, file_name: "owned.txt", is_image: false }],
    );
    const readPath = "/api/" + org + "/files/" + file.file_uuid + "/contents";
    assert.equal(await (await fetch(readPath)).text(), documentText);
    await ctx.store.close();
    ctx.store = await open("after-document-restart");
    ctx.accountActivationIdentity = {};
    ctx.selectedAttachments.clear();
    await fetch(v2);
    assert.equal(await (await fetch(readPath)).text(), documentText);
    assert.equal((await post(v2, document(file.file_uuid))).status, 200);
    assert.deepEqual(sent, [firstId, secondId, imageId, documentEventId]);
    const readReceipt = (sessionKey: string, eventId: string) =>
      fetch(
        "/v1/code/sessions/session_" +
          sessionKey +
          "/events/" +
          eventId +
          "/receipt",
      );
    assert.equal((await readReceipt(key, documentEventId)).status, 204);
    assert.equal(
      (await readReceipt(key, "f0282d8a-eb80-4c64-95b1-6d6b0de42163")).status,
      404,
    );
    assert.equal(
      (await readReceipt("f".repeat(32), documentEventId)).status,
      404,
    );

    const control = (subtype: string) => ({
      session_id: "cse_" + key,
      events: [
        {
          payload: {
            type: "control_request",
            uuid: "13518619-a16b-4b50-8a53-a159944257d3",
            request_id: "fixture-" + subtype,
            request: { subtype },
          },
        },
      ],
    });
    assert.equal((await post(v2, control("set_model"))).status, 400);
    assert.equal((await post(v2, control("initialize"))).status, 409);
    const events = await fetch(v2 + "/stream");
    assert.equal(events.status, 200);
    const reader = events.body!.getReader();
    t.after(() => reader.cancel().catch(() => {}));
    const frame = async () =>
      new TextDecoder().decode((await reader.read()).value);
    await frame();
    assert.equal((await post(v2, control("initialize"))).status, 200);
    const init = await frame();
    assert.match(init, /"request_id":"fixture-initialize"/);
    assert.match(init, /"current_permission_mode":"default"/);
    assert.doesNotMatch(init, /^id:/m);
    const current = ctx.store.conversation(original.id);
    const usage = {
      totalTokens: 17,
      inputTokens: 15,
      cachedInputTokens: 0,
      outputTokens: 2,
      reasoningOutputTokens: 0,
    };
    current.tokenUsage = {
      total: usage,
      last: usage,
      modelContextWindow: 1000,
    };
    assert.equal((await post(v2, control("get_context_usage"))).status, 200);
    const context = await frame();
    assert.match(context, /"rawMaxTokens":1000/);
    assert.match(context, /"totalTokens":17/);
    assert.deepEqual(sent, [firstId, secondId, imageId, documentEventId]);
    await reader.cancel();

    const priorityInput = (
      uuid: string,
      text: string,
      priority?: "later" | "next",
    ) => ({
      events: [{ payload: { ...event(uuid, text, "session_"), priority } }],
    });
    const controlRequest = (request: {
      subtype: string;
      [key: string]: unknown;
    }) => ({
      events: [
        {
          payload: {
            type: "control_request",
            request_id: `fixture-${request.subtype}`,
            request,
          },
        },
      ],
    });
    const stopTarget = async () => {
      const metadata = await (
        await fetch(v2.slice(0, -"/events".length))
      ).json();
      return metadata.session.claudex_stop_target?.target;
    };
    const startTurn = () => {
      const turn: Turn = {
        id: randomUUID(),
        prompt: "existing active turn",
        status: "inProgress",
        items: [],
        attachments: [],
        createdAt: Date.now(),
      };
      ctx.store.conversation(original.id).turns.push(turn);
      return turn;
    };
    const complete = (turn: Turn) => {
      turn.status = "completed";
      emit({
        type: "conversation",
        conversation: ctx.store.conversation(original.id),
      });
    };
    const onSend = (eventId: string) => {
      const observed = signal();
      observedSends.set(eventId, observed.resolve);
      return observed.promise;
    };
    const restart = async () => {
      const old = ctx.store;
      await old.close();
      ctx.store = await CloudStore.open({
        root: old.root,
        userId: user.id,
        transport,
      });
      ctx.accountActivationIdentity = {};
      ctx.selectedAttachments.clear();
    };
    const queueInputs = () =>
      officialCodeQueueInputs(
        dispatcher,
        {
          t: "call",
          id: randomUUID(),
          method: "officialUiRead",
          user,
          args: [],
          deadlineMs: 5_000,
        },
        ctx as never,
        ctx.store.conversation(original.id),
      ) ?? [];
    const cancelAfterRead = async (eventId: string) => {
      const capability = await readOfficialCapabilities(read, String(user.id));
      const answer = await action({
        method: "POST",
        path: v2,
        contentType: "application/json",
        capabilityLease: capability.activationLease,
        body: new TextEncoder().encode(
          JSON.stringify(
            controlRequest({
              subtype: "cancel_async_message",
              message_uuid: eventId,
            }),
          ),
        ),
      });
      assert.equal(answer.status, 200);
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(answer.body)).response,
        { cancelled: true },
      );
    };

    await t.test("a selected skill waits for a fresh turn and its UUID binds its exact span", async () => {
      const active = startTurn();
      const uuid = randomUUID();
      const text = "Use /fixture after /fixture";
      const selected = { kind: "local", name: "fixture", start: 19, end: 27 };
      const postSkill = (...skill_references: unknown[]) => post(v2, {
        events: [{ payload: { ...event(uuid, text, "cse_"), priority: "next", skill_references } }],
      });
      assert.equal((await postSkill({ ...selected, start: 18 })).status, 400);
      assert.equal((await postSkill(selected)).status, 200);
      assert.equal((await postSkill({ ...selected, start: 4, end: 12 })).status, 409);
      assert.ok(!sentSkills.has(uuid));
      const dispatched = onSend(uuid);
      complete(active);
      await dispatched;
      assert.deepEqual(sentSkills.get(uuid), [selected]);
      assert.equal((await postSkill(selected)).status, 200);
      assert.equal(sent.filter(id => id === uuid).length, 1);
    });

    await t.test(
      "active later requests cancel and drain exactly once in FIFO order",
      async () => {
        const active = startTurn();
        const eventStream = await fetch(v2 + "/stream");
        const live = eventStream.body!.getReader();
        try {
          await live.read();
          const [first, cancelled, last] = [
            randomUUID(),
            randomUUID(),
            randomUUID(),
          ];
          const before = sent.length;
          const firstInput = priorityInput(first, "queue first", "later");
          const cancelledInput = priorityInput(
            cancelled,
            "queue cancelled",
            "later",
          );
          const lastInput = priorityInput(last, "queue last", "later");
          const accepted = await post(v2, firstInput);
          assert.equal(accepted.status, 200);
          assert.deepEqual(
            await (await post(v2, firstInput)).json(),
            await accepted.json(),
          );
          assert.equal(
            (await post(v2, priorityInput(first, "different input", "later")))
              .status,
            409,
          );
          assert.equal((await post(v2, cancelledInput)).status, 200);
          assert.equal((await post(v2, lastInput)).status, 200);
          assert.equal((await readReceipt(key, first)).status, 404);
          assert.deepEqual(sent.slice(before), []);

          const cancel = controlRequest({
            subtype: "cancel_async_message",
            message_uuid: cancelled,
          });
          for (let attempt = 0; attempt < 2; attempt++) {
            assert.equal((await post(v2, cancel)).status, 200);
            const response = new TextDecoder().decode(
              (await live.read()).value,
            );
            assert.match(
              response,
              /"request_id":"fixture-cancel_async_message"/,
            );
            assert.match(response, /"cancelled":true/);
          }
          assert.equal((await post(v2, cancelledInput)).status, 409);

          const dispatched = onSend(last);
          complete(active);
          await dispatched;
          assert.equal((await readReceipt(key, last)).status, 204);
          assert.deepEqual(sent.slice(before), [first, last]);
          assert.equal((await readReceipt(key, cancelled)).status, 404);
        } finally {
          await live.cancel();
        }
      },
    );

    await t.test("native Code queue shares uploaded image ownership and dispatches once", async () => {
      const active = startTurn();
      ctx.store.settings.providers = [{ id: original.providerId, name: "Fixture", model: original.model,
        models: [original.model], baseUrl: "https://fixture.invalid/v1", protocol: "responses" }];
      const image = storeOfficialAttachments(ctx as never, [{ name: "native.png", data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64",
      ) }])[0];
      const input = { eventId: randomUUID(), text: "native queued image", attachmentIds: [image.id], priority: "later" };
      const submit = () => nativeQueue("queueCodeMessage", original.id, input);
      const first = await submit();
      assert.equal(first.entries[0].eventId, input.eventId);
      assert.equal(first.entries[0].attachments[0].id, image.id);
      assert.equal(first.entries[0].attachments[0].path, "");
      assert.deepEqual(await submit(), first);
      const cancelled = await nativeQueue("cancelCodeMessage", original.id, input.eventId);
      assert.deepEqual(cancelled.entries, []);
      assert.equal(fs.existsSync(image.path), true);
      const choice = { providerId: original.providerId, model: original.model, effort: "xhigh" };
      const replacement = { ...input, eventId: randomUUID(), choice };
      const ready = onSend(replacement.eventId);
      const pending = await nativeQueue("queueCodeMessage", original.id, replacement);
      assert.deepEqual(pending.entries[0].choice, choice);
      complete(active);
      await ready;
      assert.equal(sent.filter(id => id === replacement.eventId).length, 1);
      assert.equal(sent.some(id => id === input.eventId), false);
      assert.deepEqual(sentModels.get(replacement.eventId), { model: choice.model, effort: choice.effort });
      assert.equal(ctx.store.conversation(original.id).turns.at(-1)?.attachments[0]?.id, image.id);
    });

    await t.test(
      "ordinary Stop holds queued input and an explicit idle send can proceed",
      async () => {
        startTurn();
        const queued = randomUUID();
        const idle = randomUUID();
        const before = sent.length;
        assert.equal(
          (await post(v2, priorityInput(queued, "held after stop", "later")))
            .status,
          200,
        );
        const target = await stopTarget();
        assert.equal(
          (
            await post(
              v2,
              controlRequest({ subtype: "interrupt", turn_target: target }),
            )
          ).status,
          200,
        );
        assert.equal(stopCount, 1);
        assert.equal((await readReceipt(key, queued)).status, 404);
        assert.deepEqual(sent.slice(before), []);
        const { data } = await (await fetch(v2)).json();
        const [marker, result] = data.slice(-2);
        assert.equal(marker.source, "worker");
        assert.equal(marker.processing_at, undefined);
        assert.deepEqual(marker.payload.message.content, [
          { type: "text", text: "[Request interrupted by user]" },
        ]);
        assert.equal(result.payload.subtype, "success");
        assert.equal(result.payload.is_error, false);
        assert.equal(result.payload.stop_reason, undefined);

        assert.equal(
          (await post(v2, priorityInput(idle, "explicit idle send"))).status,
          200,
        );
        assert.deepEqual(sent.slice(before), [idle]);
        assert.equal((await readReceipt(key, queued)).status, 404);
        const resumed = onSend(queued);
        assert.equal(
          (
            await post(
              v2,
              controlRequest({
                subtype: "interrupt",
                queued_message_uuid: queued,
              }),
            )
          ).status,
          200,
        );
        await resumed;
        assert.equal((await readReceipt(key, queued)).status, 204);
        assert.deepEqual(sent.slice(before), [idle, queued]);
      },
    );

    await t.test(
      "Send now interrupts only for an exact queued UUID",
      async () => {
        const active = startTurn();
        const [first, selected] = [randomUUID(), randomUUID()];
        const before = sent.length;
        assert.equal(
          (await post(v2, priorityInput(first, "prior queued input", "later")))
            .status,
          200,
        );
        assert.equal(
          (
            await post(
              v2,
              priorityInput(selected, "selected Send now", "later"),
            )
          ).status,
          200,
        );
        const turnTarget = await stopTarget();
        const sendNow = (id: string) =>
          post(
            v2,
            controlRequest({
              subtype: "interrupt",
              queued_message_uuid: id,
              turn_target: turnTarget,
            }),
          );
        assert.equal((await sendNow(randomUUID())).status, 409);
        assert.equal(active.status, "inProgress");
        const dispatched = onSend(first);
        assert.equal((await sendNow(selected)).status, 200);
        await dispatched;
        assert.equal((await readReceipt(key, first)).status, 204);
        assert.equal(stopCount, 2);
        assert.deepEqual(sent.slice(before), [selected, first]);
        assert.deepEqual((await (await fetch(v2)).json()).queue, []);
      },
    );

    await t.test(
      "active next is recorded in the same turn and an unknown steer is never replayed",
      async () => {
        const active = startTurn();
        const [delivered, unknown, missed] = [
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ];
        const before = sent.length;
        const nextInput = {
          events: [
            {
              payload: {
                ...imageEvent(png),
                uuid: delivered,
                priority: "next",
              },
            },
          ],
        };
        const accepted = await post(v2, nextInput);
        assert.equal(accepted.status, 200);
        assert.equal((await readReceipt(key, delivered)).status, 204);
        const history = await (await fetch(v2)).json();
        const message = history.data.find(
          (row: { payload: { uuid: string } }) =>
            row.payload.uuid === delivered,
        );
        assert.equal(
          message.event_id,
          (await accepted.json()).events[0].event_id,
        );
        assert.equal(typeof message.processing_at, "string");
        assert.equal(message.payload.message.content[0].source.data, png);
        assert.deepEqual(
          active.items.map((item) => item.officialCodeEventId),
          [delivered],
        );
        assert.equal((await post(v2, nextInput)).status, 200);

        loseSteerReply = true;
        const unknownInput = priorityInput(
          unknown,
          "uncertain steering",
          "next",
        );
        assert.equal((await post(v2, unknownInput)).status, 409);
        loseSteerReply = false;
        assert.equal((await post(v2, unknownInput)).status, 409);
        missSteerTurn = true;
        assert.equal(
          (
            await post(
              v2,
              priorityInput(missed, "Codex refused this steer", "next"),
            )
          ).status,
          200,
        );
        missSteerTurn = false;
        assert.deepEqual(sent.slice(before), []);
        const dispatched = onSend(missed);
        complete(active);
        await dispatched;
        assert.equal((await readReceipt(key, missed)).status, 204);
        assert.deepEqual(steered, [delivered, unknown, missed]);
        assert.deepEqual(sent.slice(before), [missed]);
      },
    );

    await t.test(
      "Stop can cancel pending input and an activation change cannot send it",
      async () => {
        startTurn();
        const cancelled = randomUUID();
        const cancelledInput = priorityInput(
          cancelled,
          "cancel with Stop",
          "later",
        );
        const before = sent.length;
        assert.equal((await post(v2, cancelledInput)).status, 200);
        const capability = await readOfficialCapabilities(
          read,
          String(user.id),
        );
        const turnTarget = await stopTarget();
        const interrupt = await action({
          method: "POST",
          path: v2,
          contentType: "application/json",
          capabilityLease: capability.activationLease,
          body: new TextEncoder().encode(
            JSON.stringify(
              controlRequest({
                subtype: "interrupt",
                cancel_queued: true,
                turn_target: turnTarget,
              }),
            ),
          ),
        });
        assert.deepEqual(
          JSON.parse(new TextDecoder().decode(interrupt.body)).response,
          {
            cancelled: [cancelled],
            still_queued: [],
          },
        );
        assert.equal((await post(v2, cancelledInput)).status, 409);

        const active = startTurn();
        const retired = randomUUID();
        const retiredInput = priorityInput(
          retired,
          "old activation input",
          "later",
        );
        assert.equal((await post(v2, retiredInput)).status, 200);
        ctx.accountActivationIdentity = {};
        complete(active);
        assert.equal((await readReceipt(key, retired)).status, 404);
        assert.equal((await post(v2, retiredInput)).status, 200);
        assert.equal(
          queueInputs().find((entry) => entry.eventId === retired)?.state,
          "held",
        );
        assert.deepEqual(sent.slice(before), []);
      },
    );

    await t.test(
      "restart holds accepted inputs and retains old attachments for explicit delivery",
      async () => {
        const active = startTurn();
        const held = randomUUID();
        const cancelled = randomUUID();
        const before = sent.length;
        const input = {
          events: [
            { payload: { ...imageEvent(png), uuid: held, priority: "later" } },
          ],
        };
        const queued = await post(v2, input);
        assert.equal(queued.status, 200);
        const image = queueInputs().find((entry) => entry.eventId === held);
        assert.ok(image);
        assert.equal(image.state, "queued");
        assert.equal(image.attachments.length, 1);
        const attachment = image.attachments[0];
        const upload = await fetch(uploadPath, { method: "POST", body: form });
        assert.equal(upload.status, 200);
        const documentRef = await upload.json();
        const documentInput = (
          uuid: string,
          text: string,
          priority?: "later",
        ) => ({
          events: [
            {
              payload: {
                ...event(uuid, text, "cse_"),
                priority,
                file_attachments: document(documentRef.file_uuid).events[0]
                  .payload.file_attachments,
              },
            },
          ],
        });
        const cancelInput = documentInput(
          cancelled,
          "cancel after restart",
          "later",
        );
        assert.equal((await post(v2, cancelInput)).status, 200);
        assert.equal((await readReceipt(key, held)).status, 404);
        await restart();
        assert.equal(
          ctx.store.conversation(original.id).turns.at(-1)?.id,
          active.id,
        );
        assert.equal(
          ctx.store.conversation(original.id).turns.at(-1)?.stopReason,
          "restart",
        );
        const references = queuedCodeAttachmentIds(
          ctx.store.root,
          account.id,
          ctx.store.conversations,
        );
        assert.ok(references.includes(attachment.id));
        const old = new Date(Date.now() - attachmentRetentionMs - 60_000);
        fs.utimesSync(path.dirname(attachment.path), old, old);
        assert.ok(
          !pruneAttachments(
            ctx.store.root,
            ctx.store.conversations,
            references,
          ).includes(attachment.id),
        );
        const recoveredHistory = await (await fetch(v2)).json();
        assert.deepEqual(
          recoveredHistory.queue.find(
            (entry: { uuid: string }) => entry.uuid === held,
          ),
          {
            uuid: held,
            state: "held",
            event_id: cloudCodeEventId(`session_${key}`, held),
          },
        );
        const recoveredImage = await (
          await fetch(v2 + "/queue/" + held)
        ).json();
        assert.equal(recoveredImage.claudexQueueState, "held");
        assert.equal(
          recoveredImage.message.content.find(
            (block: { type: string }) => block.type === "image",
          ).source.data,
          png,
        );
        const recoveredDocument = await (
          await fetch(v2 + "/queue/" + cancelled)
        ).json();
        assert.deepEqual(recoveredDocument.file_attachments, [
          {
            file_uuid: documentRef.file_uuid,
            file_name: "owned.txt",
            is_image: false,
          },
        ]);
        const queuedFilePath =
          "/api/" + org + "/files/" + documentRef.file_uuid + "/contents";
        assert.equal(await (await fetch(queuedFilePath)).text(), documentText);
        assert.equal(
          (
            await fetch(v2 + "/queue/" + cancelled, {
              headers: { "x-organization-uuid": organizationUuid("other") },
            })
          ).status,
          404,
        );
        assert.equal(
          (await fetch(v2.replace(key, "f".repeat(32)) + "/queue/" + cancelled))
            .status,
          404,
        );
        assert.equal((await post(v2, input)).status, 200);
        assert.deepEqual(sent.slice(before), []);

        const sendNow = onSend(held);
        assert.equal(
          (
            await post(
              v2,
              controlRequest({
                subtype: "interrupt",
                queued_message_uuid: held,
              }),
            )
          ).status,
          200,
        );
        await sendNow;
        assert.equal((await readReceipt(key, held)).status, 204);
        assert.deepEqual(sent.slice(before), [held]);
        const delivered = ctx.store.conversation(original.id).turns.at(-1)
          ?.attachments[0];
        assert.equal(delivered?.id, attachment.id);
        assert.equal(fs.readFileSync(attachment.path).toString("base64"), png);

        await cancelAfterRead(cancelled);
        const edit = randomUUID();
        assert.equal(
          (
            await post(
              v2,
              documentInput(edit, "edited with recovered document"),
            )
          ).status,
          200,
        );
        const edited = ctx.store.conversation(original.id).turns.at(-1)
          ?.attachments[0];
        assert.ok(edited);
        assert.equal(edited.id, documentRef.file_uuid);
        assert.equal(fs.readFileSync(edited.path, "utf8"), documentText);
        await restart();
        await cancelAfterRead(cancelled);
        assert.equal((await post(v2, cancelInput)).status, 409);
        assert.equal((await fetch(v2 + "/queue/" + cancelled)).status, 404);
        assert.equal(
          queueInputs().some((entry) => entry.eventId === cancelled),
          false,
        );
        assert.equal((await post(v2, input)).status, 200);
        assert.deepEqual(sent.slice(before), [held, edit]);
      },
    );

    await t.test(
      "a saved completed blocker lets a restarted queue drain once",
      async () => {
        const active = startTurn();
        const next = randomUUID();
        const input = priorityInput(
          next,
          "resume after completed blocker",
          "later",
        );
        const before = sent.length;
        assert.equal((await post(v2, input)).status, 200);
        active.status = "completed";
        await ctx.store.sync();
        assert.deepEqual(sent.slice(before), []);
        await restart();
        const dispatched = onSend(next);
        assert.equal(
          queueInputs().find((entry) => entry.eventId === next)?.state,
          "queued",
        );
        await dispatched;
        assert.equal((await readReceipt(key, next)).status, 204);
        assert.equal((await post(v2, input)).status, 200);
        assert.equal(
          queueInputs().some((entry) => entry.eventId === next),
          false,
        );
        assert.deepEqual(sent.slice(before), [next]);
      },
    );

    await t.test(
      "acknowledged steering without a recorded UUID survives restart without another steer",
      async () => {
        startTurn();
        const eventId = randomUUID();
        const input = priorityInput(
          eventId,
          "accepted before model handoff",
          "next",
        );
        deferSteerRecord = eventId;
        assert.equal((await post(v2, input)).status, 200);
        assert.equal(
          queueInputs().find((entry) => entry.eventId === eventId)?.state,
          "sending",
        );
        assert.equal((await readReceipt(key, eventId)).status, 404);
        await restart();
        const row = await (await fetch(v2 + "/queue/" + eventId)).json();
        assert.equal(row.claudexQueueState, "unknown");
        assert.equal((await readReceipt(key, eventId)).status, 404);
        assert.equal((await post(v2, input)).status, 200);
        assert.deepEqual(
          steered.filter((id) => id === eventId),
          [eventId],
        );
        assert.equal(
          sent.some((id) => id === eventId),
          false,
        );
      },
    );

    await t.test(
      "restart does not confirm or replay a dispatch with only a provisional turn",
      async (t) => {
        const active = startTurn();
        const eventId = randomUUID();
        const after = randomUUID();
        const started = signal();
        const release = signal();
        ambiguousSend = { eventId, started, release };
        t.after(release.resolve);
        const input = priorityInput(
          eventId,
          "ambiguous queue dispatch",
          "later",
        );
        const before = sent.length;
        assert.equal((await post(v2, input)).status, 200);
        assert.equal(
          (
            await post(
              v2,
              priorityInput(after, "wait after ambiguous dispatch", "later"),
            )
          ).status,
          200,
        );
        complete(active);
        await started.promise;
        assert.equal(
          queueInputs().find((entry) => entry.eventId === eventId)?.state,
          "sending",
        );
        assert.equal((await readReceipt(key, eventId)).status, 404);
        await restart();
        release.resolve();
        assert.equal(
          queueInputs().find((entry) => entry.eventId === eventId)?.state,
          "unknown",
        );
        assert.equal(
          queueInputs().find((entry) => entry.eventId === after)?.state,
          "held",
        );
        assert.equal((await readReceipt(key, eventId)).status, 404);
        assert.equal((await post(v2, input)).status, 409);
        assert.equal(
          (
            await post(
              v2,
              controlRequest({
                subtype: "interrupt",
                queued_message_uuid: eventId,
              }),
            )
          ).status,
          409,
        );
        assert.deepEqual(sent.slice(before), [eventId]);
      },
    );

    await t.test(
      "a Stop without the observed turn cannot interrupt a replacement",
      async () => {
        const prior = startTurn();
        const target = await stopTarget();
        assert.equal(target.turnId, prior.id);
        complete(prior);
        const active = startTurn();
        const before = stopCount;
        try {
          assert.equal(
            (await post(v2, controlRequest({ subtype: "interrupt" }))).status,
            409,
          );
          assert.equal(
            (
              await post(
                v2,
                controlRequest({ subtype: "interrupt", turn_target: target }),
              )
            ).status,
            409,
          );
          assert.equal(stopCount, before);
          assert.equal(active.status, "inProgress");
        } finally {
          complete(active);
        }
      },
    );

    await t.test(
      "a failed Stop holds input even if the active turn completes",
      async () => {
        const active = startTurn();
        const queued = randomUUID();
        const before = sent.length;
        stopBehavior = async (turn) => {
          complete(turn);
          throw Error("Fixture lost the Stop response");
        };
        try {
          assert.equal(
            (
              await post(
                v2,
                priorityInput(queued, "hold after uncertain Stop", "later"),
              )
            ).status,
            200,
          );
          const target = await stopTarget();
          assert.equal(target.turnId, active.id);
          assert.equal(
            (
              await post(
                v2,
                controlRequest({ subtype: "interrupt", turn_target: target }),
              )
            ).status,
            409,
          );
          assert.equal((await readReceipt(key, queued)).status, 404);
          assert.deepEqual(sent.slice(before), []);
          assert.equal(
            queueInputs().find((entry) => entry.eventId === queued)?.state,
            "held",
          );
        } finally {
          stopBehavior = undefined;
        }
      },
    );

    await t.test(
      "Stop cancels the exact published startup and leaves no dispatch receipt",
      async () => {
        const eventId = randomUUID();
        const shown = signal(),
          resume = signal();
        startingSend = { eventId, shown, resume };
        const input = priorityInput(eventId, "stopped during preparation");
        const send = post(v2, input);
        try {
          await shown.promise;
          const target = await stopTarget();
          assert.equal(target.kind, "starting");
          assert.equal(target.turnId, "pending-" + eventId);
          const before = stopCount;
          assert.equal(
            (
              await post(
                v2,
                controlRequest({ subtype: "interrupt", turn_target: target }),
              )
            ).status,
            200,
          );
          assert.equal(stopCount, before);
          const { data } = await (
            await fetch(v2 + "?sort_order=desc&limit=5")
          ).json();
          const [result, marker, prompt] = data;
          assert.equal(result.payload.uuid, eventId + ":result");
          assert.equal(marker.source, "worker");
          assert.equal(prompt.payload.uuid, eventId);
          assert.equal(prompt.processing_at, undefined);
          assert.equal((await readReceipt(key, eventId)).status, 404);
        } finally {
          resume.resolve();
          assert.equal((await send).status, 204);
          startingSend = undefined;
        }
        assert.equal(
          queueInputs().some((entry) => entry.eventId === eventId),
          false,
        );
        assert.equal((await post(v2, input)).status, 204);
      },
    );

    await t.test(
      "Connecting Stop cancels only its own undispatched UUID",
      async () => {
        const id = randomUUID();
        const input = priorityInput(id, "cancel before engine startup");
        const entered = signal(),
          resume = signal();
        beforeEngine = { entered, resume };
        const sentBefore = sent.length;
        const stop = (startingId: string) =>
          post(
            v2,
            controlRequest({
              subtype: "interrupt",
              starting_input_uuid: startingId,
            }),
          );
        const send = post(v2, input);
        try {
          await entered.promise;
          assert.equal(await stopTarget(), undefined);
          assert.equal((await stop(randomUUID())).status, 409);
          const result = await stop(id);
          assert.equal(result.status, 200);
          assert.deepEqual(await result.json(), {
            events: [],
            cancelled_start: id,
          });
          assert.equal((await readReceipt(key, id)).status, 404);
        } finally {
          resume.resolve();
          beforeEngine = undefined;
        }
        assert.equal((await send).status, 204);
        assert.equal((await post(v2, input)).status, 204);
        assert.deepEqual(sent.slice(sentBefore), []);
      },
    );

    await t.test(
      "a stopped Code turn is published only after its durable row",
      async () => {
        const active = startTurn();
        await ctx.store.sync();
        const entered = signal();
        const release = signal();
        heldStopWrite = { entered, release };
        stopBehavior = async (turn) => {
          turn.status = "interrupted";
          turn.userStopped = true;
          ctx.store.flush();
          emit({
            type: "conversation",
            conversation: ctx.store.conversation(original.id),
          });
        };
        const target = await stopTarget();
        const prior = await fetch(v2 + "?sort_order=desc&limit=1").then(
          (reply) => reply.json(),
        );
        const from = prior.data[0].sequence_num;
        try {
          assert.equal(
            (
              await post(
                v2,
                controlRequest({ subtype: "interrupt", turn_target: target }),
              )
            ).status,
            200,
          );
          await entered.promise;
          const stream = read({
            method: "GET",
            path: v2 + "/stream?from_sequence_num=" + from,
          });
          const first = await Promise.race([
            stream.then(() => "published"),
            new Promise((resolve) => setTimeout(resolve, 30, "waiting")),
          ]);
          assert.equal(first, "waiting");
          const detail = await fetch(v2.slice(0, -"/events".length)).then(
            (reply) => reply.json(),
          );
          assert.equal(detail.session.worker_status, "running");
          release.resolve();
          const batch = JSON.parse(
            new TextDecoder().decode((await stream).body),
          );
          assert.equal(batch.session.worker_status, "idle");
          assert.equal(batch.data.at(-1).payload.uuid, active.id + ":result");
          assert.equal(batch.data.at(-1).payload.is_error, false);
          const beforeRestart = ctx.store;
          const reopened = await open("after-ack-before-close");
          try {
            ctx.store = reopened;
            ctx.accountActivationIdentity = {};
            const loaded = reopened.conversation(original.id).turns.at(-1);
            assert.equal(loaded?.id, active.id);
            assert.equal(loaded?.status, "interrupted");
            assert.equal(loaded?.userStopped, true);
            assert.equal(loaded?.stopReason, undefined);
            const restored = await fetch(v2 + "?sort_order=desc&limit=2").then(
              (reply) => reply.json(),
            );
            const [result, marker] = restored.data;
            assert.equal(result.payload.uuid, active.id + ":result");
            assert.equal(result.payload.is_error, false);
            assert.equal(marker.source, "worker");
            assert.equal(marker.payload.uuid, active.id + ":user-interrupt");
          } finally {
            ctx.store = beforeRestart;
            ctx.accountActivationIdentity = {};
            await reopened.close();
          }
        } finally {
          heldStopWrite = undefined;
          release.resolve();
          stopBehavior = undefined;
        }
      },
    );

    await t.test("Code preferences persist and an action replay does not replace a newer choice", async () => {
    ctx.store.settings.providers = [{
      id: original.providerId, name: "Fixture", model: original.model,
      models: [original.model, "no-effort-model", "gpt-image-2.5"], baseUrl: "https://fixture.invalid/v1", protocol: "responses",
    }];
    const preference = (request_id: string, request: object) => ({
      type: "control_request",
      request_id,
      request,
    });
    const model = (id: string, value: string) =>
      preference(id, { subtype: "set_model", model: value });
    const effort = (id: string, value: string) =>
      preference(id, {
        subtype: "apply_flag_settings",
        settings: { effortLevel: value, ultracode: false },
      });
    const wrapped = (...events: object[]) => ({
      events: events.map((payload) => ({ payload })),
    });
    const staleDrawing = await post(v2, wrapped(model("switch-image", "gpt-image-2.5")));
    assert.equal(staleDrawing.status, 409);
    assert.equal(ctx.store.conversation(original.id).model, original.model);
    const low = { events: [effort("select-low", "low")] };
    const lowReply = await post(legacy, low);
    assert.equal(lowReply.status, 200, await lowReply.text());
    assert.equal(ctx.store.conversation(original.id).effort, "low");
    assert.equal(
      (await post(v2, wrapped(model("switch-model", "no-effort-model"))))
        .status,
      200,
    );
    assert.equal(ctx.store.conversation(original.id).model, "no-effort-model");
    assert.equal(ctx.store.conversation(original.id).effort, undefined);
    assert.equal(
      (await post(v2, wrapped(effort("unsupported-high", "high")))).status,
      409,
    );
    assert.equal((await post(legacy, low)).status, 200);
    assert.equal(
      ctx.store.conversation(original.id).effort,
      undefined,
      "replay must not replace the later choice",
    );
    const switchedEventId = "4aa88c26-437c-46f9-9be4-c0c79be6a9ce";
    const settingsAndSend = wrapped(
      model("restore-model", original.model),
      effort("select-max", "max"),
      event(
        switchedEventId,
        "Send with the selected model and effort.",
        "cse_",
      ),
    );
    const sendReply = await post(v2, settingsAndSend);
    assert.equal(sendReply.status, 200, await sendReply.text());
    assert.equal(ctx.store.conversation(original.id).effort, "max");
    assert.equal((await post(v2, settingsAndSend)).status, 200);
    assert.equal(sent.filter((id) => id === switchedEventId).length, 1);
    await ctx.store.sync("full");
    await ctx.store.settled();
    const reopened = await open("after-model-preferences-restart");
    t.after(() => reopened.close());
    assert.equal(reopened.conversation(original.id).model, original.model);
    assert.equal(reopened.conversation(original.id).effort, "max");
    delete ctx.store.conversation(original.id).effort;

    });

    await t.test("the first original Cloud Code event applies Ultracode, and unsupported Fast mode refuses dispatch", async (t) => {
      const draft: Conversation = {
        id: "original-code-draft",
        mode: "code",
        title: "New Code session",
        providerId: original.providerId,
        model: original.model,
        effort: "low",
        updatedAt: 1,
        createdAt: 1,
        pinned: false,
        archived: false,
        turns: [],
      };
      ctx.store.conversations.push(draft);
      await ctx.store.sync("full");
      const draftKey = cloudCodeSessionKey(draft, account.id);
      const sessionId = "cse_" + draftKey;
      const detail = "/v1/code/sessions/" + sessionId;
      const url = detail + "/events";
      const control = (request: object) => ({
        type: "control_request",
        request_id: randomUUID(),
        request,
      });
      const flags = (settings: object) => control({ subtype: "apply_flag_settings", settings });
      const batch = (...payloads: object[]) => ({
        events: payloads.map((payload) => ({ payload })),
      });
      const message = (uuid: string) => ({
        ...event(uuid, "Review the dependencies", "cse_"),
        session_id: sessionId,
      });
      const metadata = async () =>
        (await fetch(detail).then((response) => response.json())).session.external_metadata;

      const fast = await post(url, batch(
        control({ subtype: "set_permission_mode", mode: "default" }),
        control({ subtype: "set_model", model: original.model }),
        flags({ effortLevel: "max" }),
        flags({ fastMode: true }),
        message(firstUltracodeId),
      ));
      assert.equal(fast.status, 409);
      assert.match(await fast.text(), /Fast mode is unavailable/);
      assert.equal((await readReceipt(draftKey, firstUltracodeId)).status, 404);
      assert.equal((await post(url, batch(flags({ fastMode: false })))).status, 200);
      assert.equal(draft.effort, "low");

      const unavailableId = randomUUID();
      const unavailableBatch = batch(flags({ ultracode: true, effortLevel: "medium" }), message(unavailableId));
      const refused = await post(url, unavailableBatch);
      assert.equal(refused.status, 409);
      assert.match(await refused.text(), /Ultracode is unavailable/);
      assert.equal((await readReceipt(draftKey, unavailableId)).status, 404);
      assert.equal(draft.effort, "low");
      assert.equal(draft.turns.length, 0);
      assert.equal(await metadata(), undefined);

      ultracodeAllowed = true;
      const firstBatch = batch(flags({ ultracode: true, effortLevel: "medium" }), message(firstUltracodeId));
      const sentReply = await post(url, firstBatch);
      assert.equal(sentReply.status, 200, await sentReply.text());
      assert.equal((await readReceipt(draftKey, firstUltracodeId)).status, 204);
      assert.equal((await metadata()).is_ultracode_active, true);
      const sessions = await fetch("/v1/code/sessions").then((response) => response.json());
      assert.equal(
        sessions.data.find(({ id }: { id: string }) => id === "session_" + draftKey)
          .external_metadata.is_ultracode_active,
        true,
      );
      const stream = await read({ method: "GET", path: url + "/stream?from_sequence_num=0" });
      assert.equal(JSON.parse(new TextDecoder().decode(stream.body)).session.external_metadata.is_ultracode_active, true);
      const pinned = await fetch(detail, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-organization-uuid": org },
        body: JSON.stringify({ add_tags: ["ui:pinned"] }),
      });
      assert.equal(pinned.status, 200);
      assert.equal((await pinned.json()).session.external_metadata.is_ultracode_active, true);

      ultracodeAllowed = false;
      assert.equal((await metadata()).is_ultracode_active, false);
      const reopened = await open("after-ultracode-first-send");
      t.after(() => reopened.close());
      assert.equal(reopened.conversation(draft.id).codeUltracode, true);
      assert.equal(reopened.conversation(draft.id).effort, "medium");

      const legacyUrl = "/v1/sessions/session_" + draftKey + "/events";
      assert.equal((await post(legacyUrl, { events: [flags({ ultracode: false })] })).status, 200);
      ultracodeAllowed = true;
      assert.equal((await post(url, firstBatch)).status, 200);
      assert.equal(sent.filter((id) => id === firstUltracodeId).length, 1);
      assert.equal((await metadata()).is_ultracode_active, false);
      assert.equal((await post(url, batch(flags({ ultracode: true })))).status, 200);
      assert.equal((await metadata()).is_ultracode_active, true);
      assert.equal(draft.effort, "medium");
    });

    for (const [outcome, title] of [
      ["completed", "the first original Web Code action succeeds during a durable repository startup"],
      ["failed", "an accepted repository startup reports its failed clone in the timeline"],
      ["stopped", "Stop cancels an accepted repository startup before dispatch"],
      ["capacity", "an accepted repository startup keeps its input when run admission is refused"],
    ]) {
      await t.test(title, async () => {
        const draft: Conversation = {
          ...original,
          id: randomUUID(),
          threadId: undefined,
          turns: [],
          cwd: path.join(root, randomUUID()),
          pendingSetup: [{ url: "https://github.com/fixture/repository" }],
        };
        ctx.store.conversations.push(draft);
        await ctx.store.sync("full");
        const clone = {
          entered: signal(),
          finish: signal(),
          error: outcome === "failed" ? "Fixture repository could not be cloned" : undefined,
          admissionError: outcome === "capacity" ? "The account is already at its run limit." : undefined,
        };
        cloneGates.set(draft.cwd!, clone);
        const draftKey = cloudCodeSessionKey(draft, account.id);
        const sessionId = "cse_" + draftKey;
        const url = "/v1/code/sessions/" + sessionId + "/events";
        const eventId = randomUUID();
        const input = { events: [{ payload: { ...event(eventId, "Review the repository", "cse_"), session_id: sessionId } }] };
        const terminal = onSend(eventId);
        const write = { entered: signal(), release: signal() };
        heldStopWrite = write;
        let response: Response | undefined;
        const action = post(url, input).then((reply) => (response = reply));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await clone.entered.promise;
          await write.entered.promise;
          assert.equal(response, undefined);
          heldStopWrite = undefined;
          write.release.resolve();
          const accepted = await Promise.race([
            action,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(Error("The first action still waits for the repository clone")), 3_000);
            }),
          ]);
          assert.equal(accepted.status, 200);
          assert.deepEqual(await accepted.json(), {
            events: [{ event_id: cloudCodeEventId("session_" + draftKey, eventId) }],
          });
          const stored = web.users.get(user.id)?.turns.get(draft.id);
          assert.ok([...stored?.values() ?? []].some(({ turn }) =>
            turn.officialCodeEventId === eventId && turn.status === "inProgress"));
          assert.equal((await post(url, input)).status, 200);
          assert.equal((await readReceipt(draftKey, eventId)).status, 204);
          assert.deepEqual(sent.filter((id) => id === eventId), [eventId]);
          if (outcome === "stopped") {
            const detail = await (await fetch(url.slice(0, -"/events".length))).json();
            const target = detail.session.claudex_stop_target.target;
            assert.equal(target.kind, "starting");
            assert.equal(target.turnId, "pending-" + eventId);
            assert.equal((await post(url, controlRequest({ subtype: "interrupt", turn_target: target }))).status, 200);
          }
        } finally {
          clearTimeout(timer);
          heldStopWrite = undefined;
          write.release.resolve();
          clone.finish.resolve();
          await action;
          await terminal;
          cloneGates.delete(draft.cwd!);
        }
        await ctx.store.sync("full");
        const stream = await read({ method: "GET", path: url + "/stream?from_sequence_num=0" });
        assert.equal(stream.status, 200);
        const history = JSON.parse(new TextDecoder().decode(stream.body));
        assert.equal(history.session.worker_status, "idle");
        assert.equal(history.data.filter((row: { payload: { uuid: string } }) =>
          row.payload.uuid === eventId).length, 1);
        const result = history.data.find((row: { payload: { uuid: string } }) =>
          row.payload.uuid === eventId + ":result");
        assert.ok(result, "The accepted input has a terminal result");
        const error = clone.error ?? clone.admissionError;
        assert.equal(result.payload.is_error, Boolean(error));
        if (error) assert.deepEqual(result.payload.errors, [error]);
        assert.equal((await post(url, input)).status, outcome === "stopped" ? 204 : 200);
        assert.equal((await readReceipt(draftKey, eventId)).status, outcome === "stopped" ? 404 : 204);
        assert.deepEqual(sent.filter((id) => id === eventId), [eventId]);
      });
    }
  },
);
