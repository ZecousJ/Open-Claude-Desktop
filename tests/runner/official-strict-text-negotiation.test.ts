/** Actual authenticated handler + runner adapter; inert executor and temporary receipt stores only. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { officialUiRead } from "../../runner/src/official-ui-read";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import {
  officialUiCapabilitiesPath,
  officialUiActionPath,
  type OfficialUiReadRequest,
} from "../../shared/official-ui-web";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import type { Conversation } from "../../shared/types";
import type { StrictTextExecution } from "../../runner/src/official-ui-text-authority";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { deepCreate, registryFor } from "../../electron/official-ui/api/timeline";
const conv = "11111111-1111-4111-8111-111111111111";
const project = "11111111-2222-4111-8111-111111111111";
const body = () => ({
  prompt: "Inert source test",
  model: "fixture-model",
  tools: [],
  attachments: [],
  files: [],
  sync_sources: [],
  rendering_mode: "messages",
  turn_message_uuids: {
    human_message_uuid: "22222222-2222-4222-8222-222222222222",
    assistant_message_uuid: "33333333-3333-4333-8333-333333333333",
  },
  completion_request_id: "44444444-4444-4444-8444-444444444444",
  create_conversation_params: {
    name: "",
    model: "fixture-model",
    include_conversation_preferences: true,
    is_temporary: false,
  },
});
function fixture(t: any) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "strict-text-negotiation-"),
  );
  t.after(async () => {
    t.mock.restoreAll();
    await new Promise((r) => setTimeout(r, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let identity: unknown = {},
    account = "owner",
    stateRoot = root,
    executes = 0,
    legacySends = 0,
    legacyInterrupts = 0,
    inspectCalls = 0;
  let snapshotHook: () => Promise<void> = async () => {};
  let readiness: any = { state: "ready", reason: "ready" },
    conversation: any;
  let inspect: () => Promise<any> = async () => readiness;
  let engineSend = (_input: unknown): unknown => {
    throw Error("Engine send must not execute in strict mode");
  };
  let engineEdit = (..._args: unknown[]): unknown => { throw Error("Unexpected edit"); };
  let executor: (input: StrictTextExecution) => Promise<any> = async (
    input,
  ) => {
    conversation = {
      id: conv,
      mode: "chat",
      providerId: "p",
      model: "fixture-model",
      createdAt: 1,
      updatedAt: 1,
      turns: [
        {
          id: "turn",
          prompt: input.send.text,
          createdAt: 1,
          status: "completed",
          attachments: [],
          items: [{ type: "agentMessage", id: "a", text: "Inert result" }],
        },
      ],
    };
    return conversation;
  };
  const executions: StrictTextExecution[] = [];
  const authority = {
    inspect: async () => {
      inspectCalls++;
      return inspect();
    },
    execute: async (input: StrictTextExecution) => {
      executes++;
      executions.push(input);
      return executor(input);
    },
  };
  const ctx: any = {
    userId: 7,
    signedOut: false,
    closedFlag: false,
    get activeAccount() {
      return { id: account, email: "fixture@example.invalid", name: "Fixture" };
    },
    officialSessionIdentity: () => identity,
    setAccessToken() {},
    reclaimCaches() {},
    onEvent: () => () => {},
    appVersion: "test",
    log() {},
    store: {
      get root() {
        return stateRoot;
      },
      settings: {
        activeProviderId: "p",
        providers: [
          {
            id: "p",
            model: "fixture-model",
            models: ["fixture-model"],
            protocol: "chat",
            baseUrl: "https://fixture.invalid/unused",
          },
        ],
      },
    },
  };
  const dispatcher: any = {
    methods: [],
    options: {
      officialUiRoot: path.resolve("build/official-ui"),
      officialUiActions: true,
      officialUiStrictTextChat: { executor: authority },
    },
    guard: { modes: ["chat"] },
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 1,
    run: async (frame: any) => {
      if (frame.method === "editPrompt") return engineEdit(...(decodeWireValue(frame.args) as unknown[]));
      if (frame.method === "send") {
        legacySends++;
        return engineSend((decodeWireValue(frame.args) as unknown[])[0]);
      }
      if (frame.method === "snapshot") {
        await snapshotHook();
        return {
          conversations: conversation ? [conversation] : [],
          projects: [{ id: project, kind: "chat", name: "Fixture", createdAt: 1 }],
        };
      }
      if (frame.method === "conversationTurns")
        return { turns: conversation?.turns ?? [] };
      if (frame.method === "modelCatalog")
        return {
          defaultModel: "fixture-model",
          items: [
            {
              id: "fixture-model",
              displayName: "Fixture",
              description: "Inert",
              badges: [],
              sort: 0,
              hidden: false,
              isDefault: true,
              usageHint: "",
              efforts: [],
            },
          ],
        };
      if (frame.method === "interrupt") { legacyInterrupts++; return { status: "already_finished" }; }
      throw Error(`Unexpected inert method ${frame.method}`);
    },
  };
  const call = (request: OfficialUiReadRequest, method = "officialUiRead") =>
    officialUiRead(dispatcher, {
      t: "call",
      id: "fixture-call",
      method,
      args: encodeWireValue([request]),
      user: { id: 7, accessToken: "INERT_TEST_VALUE" },
    } as any) as Promise<any>;
  const describe = async () => {
    const answer = await call({
      method: "GET",
      path: officialUiCapabilitiesPath,
    });
    return { ...answer, data: JSON.parse(Buffer.from(answer.body).toString()) };
  };
  const submit = (lease: string | undefined, value: any = body()) =>
    call(
      {
        method: "POST",
        path: `/api/organizations/${organizationUuid(account)}/chat_conversations/${conv}/completion`,
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(value)),
        ...(lease ? { capabilityLease: lease } : {}),
      },
      "officialUiAction",
    );
  return {
    root,
    ctx,
    dispatcher,
    call,
    describe,
    submit,
    executions,
    retire: () => (identity = {}),
    rootChange: (value: string) => (stateRoot = value),
    readiness: (value: any) => (readiness = value),
    inspect: (fn: typeof inspect) => (inspect = fn),
    executor: (fn: typeof executor) => (executor = fn),
    engineSend: (fn: typeof engineSend) => (engineSend = fn),
    engineEdit: (fn: typeof engineEdit) => (engineEdit = fn),
    snapshotHook: (fn: typeof snapshotHook) => (snapshotHook = fn),
    setConversation: (value: Conversation) => (conversation = value),
    get executes() {
      return executes;
    },
    get legacySends() {
      return legacySends;
    },
    get legacyInterrupts() { return legacyInterrupts; },
    get inspectCalls() {
      return inspectCalls;
    },
  };
}
test("strict configuration without an executor remains unavailable despite enabled engine actions", async (t) => {
  const f = fixture(t);
  f.dispatcher.options.officialUiStrictTextChat = {};
  const absent = await f.describe();
  assert.equal(absent.status, 200);
  assert.equal(absent.data.textChat.reason, "executor_unavailable");
  assert.equal((await f.submit(absent.data.activationLease)).status, 501);
  assert.deepEqual(fs.readdirSync(f.root), []);
  assert.equal(f.executes, 0);
  assert.equal(f.legacySends, 0);
  f.dispatcher.options.officialUiStrictTextChat = undefined;
  assert.equal((await f.describe()).data.mode, "engine-chat");
  f.dispatcher.options.officialUiActions = false;
  const readOnly = (await f.describe()).data;
  assert.equal(readOnly.mode, "read-only");
  assert.equal(readOnly.textChat.reason, "strict_mode_disabled");
});
test("ordinary Chat negotiation reaches the existing send and rejects retired leases before dispatch", async (t) => {
  const f = fixture(t);
  f.dispatcher.options.officialUiStrictTextChat = undefined;
  const cap = (await f.describe()).data;
  assert.equal(cap.accountId, "7");
  assert.equal(cap.mode, "engine-chat");
  assert.deepEqual(cap.textChat, { state: "ready", reason: "ready" });
  const seen: unknown[] = [];
  f.engineSend((input) => {
    seen.push(input);
    return { id: conv, mode: "chat", turns: [] };
  });
  f.retire();
  assert.equal((await f.submit(cap.activationLease)).status, 409);
  assert.deepEqual(seen, []);
  const submit = negotiatedOfficialAction({
    mode: "engine-chat",
    accountId: "7",
    isCurrent: () => true,
    read: f.call,
    action: (request) => f.call(request, "officialUiAction"),
  });
  const answer = await submit({
    method: "POST",
    path: `/api/organizations/${organizationUuid("owner")}/chat_conversations/${conv}/completion`,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(body())),
  });
  assert.equal(answer.status, 200, Buffer.from(answer.body).toString());
  assert.deepEqual(seen, [{ newConversationId: conv, mode: "chat", text: body().prompt,
    attachments: [], providerId: "p", model: "fixture-model" }]);
  assert.equal(f.executes, 0);
  assert.equal(f.inspectCalls, 0);
});
test("leased official action edits the first message in the existing conversation", async (t) => {
  const f = fixture(t);
  f.dispatcher.options.officialUiStrictTextChat = undefined;
  const cap = (await f.describe()).data;
  const original = { id: "first-turn", prompt: "original", createdAt: 1, status: "completed" as const, attachments: [], items: [] };
  const conversation: Conversation = { id: conv, title: "Fixture", pinned: false, archived: false, mode: "chat", providerId: "p", model: "fixture-model", createdAt: 1, updatedAt: 1, turns: [original] };
  f.setConversation(conversation);
  const edits: unknown[][] = [];
  f.engineEdit((...args) => {
    edits.push(args);
    return { ...conversation, turns: [original, { ...original, id: "edited-turn", prompt: "edited" }] };
  });
  const registry = registryFor(path.resolve("build/official-ui"));
  const input = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const output = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
  const body = toBinary(input, deepCreate(input, {
    header: { conversationId: conv, existingOnly: true, mutationId: { sessionId: "edit-test", version: 1n } },
    action: { case: "sendMessage", value: { parentMessageId: "", text: "edited", messageId: "22222222-2222-4222-8222-222222222222", assistantMessageId: "33333333-3333-4333-8333-333333333333" } },
  }));
  const response = await f.call({ method: "POST", path: officialUiActionPath, contentType: "application/proto", body, capabilityLease: cap.activationLease }, "officialUiAction");
  assert.equal(response.status, 200);
  assert.equal((fromBinary(output, response.body) as any).ack.outcome.case, "applied");
  assert.deepEqual(edits, [[conv, "first-turn", "edited", "p", "fixture-model", { attachments: [] }]]);
});
test("REST root edit requires a current Chat lease and refuses attachment replacement", async (t) => {
  const f = fixture(t);
  f.dispatcher.options.officialUiStrictTextChat = undefined;
  const cap = (await f.describe()).data;
  const original = { id: "first-turn", prompt: "original", createdAt: 1, status: "completed" as const, attachments: [], items: [] };
  const conversation: Conversation = { id: conv, title: "Fixture", pinned: false, archived: false, mode: "chat", providerId: "p", model: "fixture-model", createdAt: 1, updatedAt: 1, turns: [original] };
  f.setConversation(conversation);
  const edits: unknown[][] = [];
  f.engineEdit((...args) => {
    edits.push(args);
    return { ...conversation, turns: [{ ...original, id: "edited-turn", prompt: "edited" }] };
  });
  const input = { ...body(), prompt: "edited", parent_message_uuid: "00000000-0000-4000-8000-000000000000" };
  delete (input as Partial<typeof input>).create_conversation_params;
  assert.equal((await f.submit(undefined, input)).status, 403);
  assert.notEqual((await f.submit(cap.activationLease, { ...input, files: ["unowned"] })).status, 200);
  assert.equal((await f.submit(cap.activationLease, { ...input, parent_message_uuid: "foreign-parent" })).status, 403);
  assert.equal(edits.length, 0);
  const response = await f.submit(cap.activationLease, input);
  assert.equal(response.status, 200, Buffer.from(response.body).toString());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].slice(0, 5), [conv, "first-turn", "edited", "p", "fixture-model"]);
  f.retire();
  assert.equal((await f.submit(cap.activationLease, input)).status, 409);
  assert.equal(edits.length, 1);
});
test("strict text mode refuses REST root edits", async (t) => {
  const f = fixture(t);
  const cap = (await f.describe()).data;
  const response = await f.submit(cap.activationLease, { ...body(), parent_message_uuid: "00000000-0000-4000-8000-000000000000" });
  assert.equal(response.status, 403);
  assert.equal(f.executes, 0);
});
test("strict mode requires current account lease and rejects RPC/unrelated mutation bypass", async (t) => {
  const f = fixture(t),
    cap = (await f.describe()).data;
  assert.equal((await f.submit(undefined)).status, 409);
  assert.equal(
    (
      await f.call(
        {
          method: "POST",
          path: officialUiActionPath,
          body: new Uint8Array(),
          contentType: "application/proto",
          capabilityLease: cap.activationLease,
        },
        "officialUiAction",
      )
    ).status,
    501,
  );
  for (const patch of [
    { enabled_monkeys_in_a_barrel: false },
    { enabled_monkeys_in_a_barrel: true, enabled_artifacts_attachments: false, preview_feature_uses_artifacts: true },
    { preview_feature_uses_artifacts: false },
  ]) {
    const result = await f.call({ method: "PATCH", path: "/api/account/settings", contentType: "application/json", body: Buffer.from(JSON.stringify(patch)), capabilityLease: cap.activationLease }, "officialUiAction");
    assert.equal(result.status, 501);
  }
  const move = await f.call({
    method: "POST",
    path: `/api/organizations/${organizationUuid("owner")}/chat_conversations/move_many`,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({ conversation_uuids: [conv], project_uuid: null })),
    capabilityLease: cap.activationLease,
  }, "officialUiAction");
  assert.equal(move.status, 501);
  assert.match(Buffer.from(move.body).toString(), /Strict text mode does not support this action/);
  f.retire();
  assert.equal((await f.submit(cap.activationLease)).status, 409);
  assert.equal(f.executes, 0);
  assert.equal(f.legacySends, 0);
  assert.deepEqual(fs.readdirSync(f.root), []);
});
test("project rows in strict and read-only Web modes do not advertise moves", async (t) => {
  const f = fixture(t);
  const path = `/api/organizations/${organizationUuid("owner")}/projects_v2?permission_filter=chat_create`;
  for (const mode of ["strict-text", "read-only"]) {
    assert.equal((await f.describe()).data.mode, mode);
    const response = await f.call({ method: "GET", path });
    assert.equal(response.status, 200);
    const [target] = JSON.parse(Buffer.from(response.body).toString()).data;
    assert.equal(target.uuid, project);
    assert.equal(target.claudex_can_move_conversation, undefined);
    assert.deepEqual(target.permissions, ["chat_project:chat:view", "chat_project:knowledge:view"]);
    f.dispatcher.options.officialUiStrictTextChat = undefined;
    f.dispatcher.options.officialUiActions = false;
  }
});
test("strict text mode rejects both original REST retry routes", async (t) => {
  const f = fixture(t);
  const capability = (await f.describe()).data;
  for (const endpoint of ["retry_completion", "retry_completion2"]) {
    const response = await f.call({
      method: "POST",
      path: `/api/organizations/${organizationUuid("owner")}/chat_conversations/${conv}/${endpoint}`,
      contentType: "application/json",
      body: Buffer.from("{}"),
      capabilityLease: capability.activationLease,
    }, "officialUiAction");
    assert.equal(response.status, 501);
  }
  assert.equal(f.executes, 0);
  assert.equal(f.legacySends, 0);
});
test("remote Cowork project actions require the current engine-chat lease", async (t) => {
  const f = fixture(t);
  f.dispatcher.guard.modes.push("cowork");
  const conversation: Conversation = {
    id: "saved-cowork",
    title: "Task",
    mode: "cowork",
    environment: { kind: "space", spaceId: "workspace" },
    providerId: "p",
    model: "fixture-model",
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    turns: [],
  };
  f.setConversation(conversation);
  const org = organizationUuid("owner");
  const request = {
    method: "PATCH" as const,
    path: `/api/organizations/${org}/cowork/sessions/cse_${cloudCodeSessionKey(conversation, "owner")}/project`,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({ project_uuid: project })),
  };
  const account = async () => JSON.parse(Buffer.from((await f.call({ method: "GET", path: "/api/account" })).body).toString());
  const strict = (await f.describe()).data;
  assert.equal((await f.call({ ...request, capabilityLease: strict.activationLease }, "officialUiAction")).status, 501);
  assert.equal((await account()).claudex_web_cowork_history.project_move, undefined);
  f.dispatcher.options.officialUiStrictTextChat = undefined;
  f.retire();
  assert.equal((await f.call(request, "officialUiAction")).status, 409);
  assert.equal((await f.call({ ...request, capabilityLease: strict.activationLease }, "officialUiAction")).status, 409);
  const engine = (await f.describe()).data;
  assert.equal(engine.mode, "engine-chat");
  assert.equal((await account()).claudex_web_cowork_history.project_move, true);
  const original = f.dispatcher.run;
  let updates = 0;
  f.dispatcher.run = async (frame: { method: string; args: unknown }) => {
    if (frame.method !== "updateConversation") return original(frame);
    updates++;
    const [id, patch] = decodeWireValue(frame.args) as [string, { projectId: { target: string } }];
    assert.equal(id, conversation.id);
    conversation.projectId = patch.projectId.target;
    return conversation;
  };
  assert.equal((await f.call({ ...request, contentType: "text/plain", capabilityLease: engine.activationLease }, "officialUiAction")).status, 400);
  const action = negotiatedOfficialAction({
    mode: "engine-chat",
    accountId: "7",
    isCurrent: () => true,
    read: f.call,
    action: (value) => f.call(value, "officialUiAction"),
  });
  assert.equal((await action(request)).status, 204);
  assert.equal(updates, 1);
  assert.equal(conversation.projectId, project);
  assert.equal(f.legacySends, 0);
});
test("real strict completion binds executor operation/hash and durable retry never executes twice", async (t) => {
  const f = fixture(t),
    cap = (await f.describe()).data;
  const first = await f.submit(cap.activationLease);
  assert.equal(first.status, 200);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.executes, 1);
  assert.equal(f.legacySends, 0);
  assert.equal(f.executions[0].accountId, "owner");
  assert.match(f.executions[0].operationKey, /^[a-f0-9]{64}$/);
  assert.match(f.executions[0].payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(f.executions[0].send.model, "fixture-model");
  assert.equal(f.executions[0].send.providerId, "p");
  assert.equal((await f.submit(cap.activationLease)).status, 200);
  assert.equal(f.executes, 1);
  assert.equal(
    (await f.submit(cap.activationLease, { ...body(), prompt: "different" }))
      .status,
    409,
  );
  assert.equal(f.executes, 1);
  const alias = {
    ...body(),
    completion_request_id: "55555555-5555-4555-8555-555555555555",
  };
  assert.equal((await f.submit(cap.activationLease, alias)).status, 200);
  assert.equal(f.executes, 1);
});
test("unknown tools are rejected by real completion validator before executor, never silently dropped", async (t) => {
  const f = fixture(t),
    cap = (await f.describe()).data;
  assert.equal(
    (
      await f.submit(cap.activationLease, {
        ...body(),
        tools: [{ type: "unknown" }],
      })
    ).status,
    501,
  );
  assert.equal(f.executes, 0);
  assert.equal(f.legacySends, 0);
});
test("readiness denial/error/malformed facts are not permission and do not reserve a completion", async (t) => {
  const f = fixture(t);
  for (const readiness of [
    { state: "denied", reason: "approval_required" },
    { state: "unavailable", reason: "budget_unavailable" },
    { state: "ready", reason: "source_error" },
    null,
  ]) {
    f.readiness(readiness);
    const cap = (await f.describe()).data;
    assert.notEqual(cap.textChat.state, "ready");
    assert.equal((await f.submit(cap.activationLease)).status, 501);
  }
  f.inspect(async () => {
    throw Error("private authority error");
  });
  const error = await f.describe();
  assert.equal(error.data.textChat.reason, "source_error");
  assert.doesNotMatch(Buffer.from(error.body).toString(), /private authority/);
  assert.equal(f.executes, 0);
  assert.deepEqual(fs.readdirSync(f.root), []);
});
test("retirement during capability await never returns a usable descriptor", async (t) => {
  const f = fixture(t);
  f.inspect(async () => {
    f.retire();
    return { state: "ready", reason: "ready" };
  });
  assert.equal((await f.describe()).status, 409);
  assert.equal(f.executes, 0);
});
test("executor unknown delivery remains tombstoned and retirement never exposes a completed result", async (t) => {
  const f = fixture(t),
    cap = (await f.describe()).data;
  f.executor(async (input) => {
    assert.equal(input.isCurrent(), true);
    f.retire();
    assert.equal(input.isCurrent(), false);
    throw Error("unknown delivery");
  });
  await f.submit(cap.activationLease);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.executes, 1);
  const next = (await f.describe()).data;
  assert.equal((await f.submit(next.activationLease)).status, 409);
  assert.equal(f.executes, 1);
  assert.equal(f.legacySends, 0);
});

test("a readiness revocation at the canonical send boundary never invokes executor or legacy send", async (t) => {
  const f = fixture(t);
  let checks = 0;
  f.inspect(async () =>
    ++checks >= 3
      ? { state: "denied", reason: "approval_required" }
      : { state: "ready", reason: "ready" },
  );
  const cap = (await f.describe()).data;
  await f.submit(cap.activationLease);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.executes, 0);
  assert.equal(f.legacySends, 0);
  assert.ok(checks >= 3);
});
test("root retirement during readiness await and capability query body are rejected before receipts", async (t) => {
  const f = fixture(t),
    cap = (await f.describe()).data;
  assert.equal(
    (
      await f.call({
        method: "GET",
        path: officialUiCapabilitiesPath,
        body: new Uint8Array(),
      })
    ).status,
    400,
  );
  const other = path.join(f.root, "new-root");
  fs.mkdirSync(other);
  f.inspect(async () => {
    f.rootChange(other);
    return { state: "ready", reason: "ready" };
  });
  assert.equal((await f.submit(cap.activationLease)).status, 409);
  assert.equal(f.executes, 0);
  assert.deepEqual(fs.readdirSync(other), []);
});
test("strict Stop truthfully refuses missing executor cancellation even after budget denial", async (t) => {
  const f = fixture(t),
    cap = (await f.describe()).data;
  await f.submit(cap.activationLease);
  await new Promise((r) => setTimeout(r, 5));
  f.readiness({ state: "denied", reason: "budget_unavailable" });
  const result = await f.call(
    {
      method: "POST",
      path: `/api/organizations/${organizationUuid("owner")}/chat_conversations/${conv}/stop_response`,
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({ completion_request_id: body().completion_request_id }),
      ),
      capabilityLease: cap.activationLease,
    },
    "officialUiAction",
  );
  assert.equal(result.status, 501);
  assert.equal(f.legacyInterrupts, 0);
  assert.match(Buffer.from(result.body).toString(), /cancellation/);
  assert.equal(f.executes, 1);
  assert.equal(f.legacySends, 0);
});

test("authority and server opt-in replacement during readiness or snapshot await revokes old execution", async (t) => {
  for (const stage of ["inspect", "snapshot"] as const)
    for (const revoke of ["executor", "actions", "mode"] as const) {
      const f = fixture(t),
        cap = (await f.describe()).data;
      let replacements = 0;
      const change = () => {
        if (revoke === "executor")
          f.dispatcher.options.officialUiStrictTextChat.executor = {
            inspect: async () => ({ state: "ready", reason: "ready" }),
            execute: async () => {
              replacements++;
              throw Error("must negotiate new lease");
            },
          };
        if (revoke === "actions")
          f.dispatcher.options.officialUiActions = false;
        if (revoke === "mode")
          f.dispatcher.options.officialUiStrictTextChat = undefined;
      };
      if (stage === "inspect")
        f.inspect(async () => {
          await Promise.resolve();
          change();
          return { state: "ready", reason: "ready" };
        });
      else
        f.snapshotHook(async () => {
          await Promise.resolve();
          change();
        });
      await f.submit(cap.activationLease);
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(f.executes, 0);
      assert.equal(replacements, 0);
      assert.equal(f.legacySends, 0);
    }
});

test("authenticated context mismatch and foreign organization never reach executor", async (t) => {
  const f = fixture(t),
    cap = (await f.describe()).data;
  const foreign = await f.call(
    {
      method: "POST",
      path: `/api/organizations/${organizationUuid("other")}/chat_conversations/${conv}/completion`,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(body())),
      capabilityLease: cap.activationLease,
    },
    "officialUiAction",
  );
  assert.equal(foreign.status, 404);
  assert.equal(f.executes, 0);
  f.ctx.userId = 8;
  await assert.rejects(() => f.describe(), /session has ended/);
  assert.equal(f.executes, 0);
});

test("pending strict Stop never interrupts an unrelated legacy operation or a replacement executor", async t => {
  const f = fixture(t); const cap = (await f.describe()).data;
  let finish!: (value: any) => void;
  f.executor(() => new Promise(resolve => finish = resolve));
  await f.submit(cap.activationLease);
  for (let i = 0; i < 20 && !finish; i++) await new Promise(r => setTimeout(r, 1));
  assert.equal(f.executes, 1);
  // This unrelated legacy operation must never receive generic interrupt.
  let unrelatedInterrupts = 0;
  const originalRun = f.dispatcher.run;
  f.dispatcher.run = async (frame: any, ...args: any[]) => {
    if (frame.method === "interrupt") { unrelatedInterrupts++; return { status: "accepted" }; }
    return originalRun(frame, ...args);
  };
  const stop = (lease: string) => f.call({ method: "POST", path: `/api/organizations/${organizationUuid("owner")}/chat_conversations/${conv}/stop_response`, contentType: "application/json", body: Buffer.from(JSON.stringify({ completion_request_id: body().completion_request_id })), capabilityLease: lease }, "officialUiAction");
  assert.equal((await stop(cap.activationLease)).status, 501);
  f.readiness({ state: "denied", reason: "budget_unavailable" });
  assert.equal((await stop(cap.activationLease)).status, 501);
  let replacementCalls = 0;
  f.dispatcher.options.officialUiStrictTextChat.executor = { inspect: async () => ({ state: "ready", reason: "ready" }), execute: async () => { replacementCalls++; throw Error("must not execute"); } };
  assert.equal((await stop(cap.activationLease)).status, 409);
  const replacement = (await f.describe()).data;
  assert.equal((await stop(replacement.activationLease)).status, 501);
  assert.equal(unrelatedInterrupts, 0); assert.equal(replacementCalls, 0); assert.equal(f.executes, 1);
  finish({ id: conv, turns: [] });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(unrelatedInterrupts, 0);
});

test("artifact review is advertised only for the active engine Chat host", async (t) => {
  const f = fixture(t);
  const account = async () => {
    const response = await f.call({ method: "GET", path: "/api/account" });
    assert.equal(response.status, 200);
    return JSON.parse(Buffer.from(response.body).toString());
  };
  assert.equal((await account()).claudex_chat_artifact_review, undefined);
  f.dispatcher.options.officialUiStrictTextChat = undefined;
  assert.equal((await account()).claudex_chat_artifact_review, true);
  f.dispatcher.options.officialUiActions = false;
  assert.equal((await account()).claudex_chat_artifact_review, undefined);
  f.dispatcher.options.officialUiActions = true;
  f.dispatcher.guard.modes = ["code"];
  assert.equal((await account()).claudex_chat_artifact_review, undefined);
});

test("publication requires the current engine Chat lease", async (t) => {
  const f = fixture(t);
  const request = {method: "POST" as const, path: `/api/organizations/${organizationUuid("fixture-account")}/publish_artifact`, contentType: "application/json", body: Buffer.from("{}")};
  const strict = (await f.describe()).data;
  assert.equal((await f.call({...request, capabilityLease: strict.activationLease}, "officialUiAction")).status, 409);
  f.dispatcher.options.officialUiStrictTextChat = undefined;
  const engine = (await f.describe()).data;
  assert.equal((await f.call(request, "officialUiAction")).status, 409);
  assert.equal((await f.call({...request, capabilityLease: strict.activationLease}, "officialUiAction")).status, 409);
  const unavailable = await f.call({...request, capabilityLease: engine.activationLease}, "officialUiAction");
  assert.equal(unavailable.status, 404);
  f.dispatcher.options.officialUiActions = false;
  await assert.rejects(f.call({...request, capabilityLease: engine.activationLease}, "officialUiAction"), /Not available/);
});
