import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { connectorUuid } from "../../electron/official-ui/api/connector-auth";
import { deepCreate, registryFor } from "../../electron/official-ui/api/timeline";
import { openOfficialCompletion } from "../../shared/official-completion-stream";
import { officialUiActionPath, type OfficialUiReadRequest } from "../../shared/official-ui-web";
const conv = "11111111-1111-7111-8111-111111111111";
const body = () => ({
  prompt: "Local deterministic test",
  model: "fixture-model",
  tools: [],
  attachments: [],
  files: [],
  sync_sources: [],
  rendering_mode: "messages",
  turn_message_uuids: {
    human_message_uuid: "22222222-2222-7222-8222-222222222222",
    assistant_message_uuid: "33333333-3333-7333-8333-333333333333",
  },
  completion_request_id: "44444444-4444-4444-8444-444444444444",
  create_conversation_params: {
    name: "",
    model: "fixture-model",
    include_conversation_preferences: true,
    is_temporary: false,
  },
});
const connectorName = "fixture-probe";
const connectorUrl = "https://example.test/mcp";
const connectorTool = {
  name: "read_example",
  description: "Read a public example",
  input_schema: { type: "object", properties: {} },
  integration_name: "Fixture Probe",
  mcp_server_uuid: connectorUuid(connectorName),
  mcp_server_url: connectorUrl,
  needs_approval: true,
  backend_execution: true,
  is_mcp_app: false,
};
function fixture(t: any, enabled = true, connectorMetadata = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rest-integration-"));
  t.after(async () => {
    // These fixtures queue real 500 ms adapter-state saves; keep their owned
    // temporary directory alive until the queue runs. Do not hide write errors.
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let owner = "one",
    identity = 1,
    conversation: any = undefined,
    failSnapshot = false,
    retireSnapshot = false,
    beforeSnapshot: (() => Promise<void>) | undefined;
  let catalog: any = {
    defaultModel: "fixture-model",
    items: [
      {
        id: "fixture-model",
        displayName: "Fixture",
        description: "",
        badges: [],
        sort: 0,
        hidden: false,
        isDefault: true,
        usageHint: "",
      },
    ],
  };
  let finishSend: (value: any) => void = () => {};
  const calls: { method: string; args: unknown[] }[] = [];
  const host: any = {
    allowCompletionConnectorMetadata: connectorMetadata,
    account: () => ({
      id: owner,
      name: "Fixture",
      email: "fixture@example.invalid",
    }),
    settings: () => ({
      activeProviderId: "fixture-provider",
      mcpServers: { [connectorName]: { url: connectorUrl } },
      providers: [
        {
          id: "fixture-provider",
          name: "Fixture",
          protocol: "responses",
          model: "fixture-model",
          models: ["fixture-model"],
        },
      ],
    }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    onEvent: () => () => {},
    appVersion: "test",
    log() {},
  };
  const dispatch = async (method: string, args: unknown[]) => {
    calls.push({ method, args });
    if (method === "snapshot") {
      if (beforeSnapshot) await beforeSnapshot();
      if (retireSnapshot) identity++;
      if (failSnapshot) throw Error("synthetic private source failure");
      return {
        conversations: conversation ? [conversation] : [],
        projects: [],
      };
    }
    if (method === "conversationTurns") return { turns: conversation.turns };
    if (method === "mcpServers")
      return { servers: [{
        name: connectorName, displayName: "Fixture Probe", url: connectorUrl,
        state: "ready", toolList: [
          { name: connectorTool.name, enabled: false, definition: { name: connectorTool.name } },
          { name: "disabled_placeholder", enabled: false },
        ],
      }] };
    if (method === "artifactNotes") return [];
    if (method === "modelCatalog") {
      if (catalog instanceof Error) throw catalog;
      return catalog;
    }
    if (method === "interrupt") return { status: "accepted" };
    if (method === "discardIncognito") { if (!conversation?.incognito) throw Error("not temporary"); conversation = undefined; return; }
    if (method === "retryResponse") return conversation;
    if (method === "send")
      return new Promise((resolve) => {
        finishSend = resolve;
      });
    throw Error("Unexpected mock method " + method);
  };
  const make = () =>
    createRunnerOfficialAdapter(
      host,
      dispatch,
      path.resolve("build/official-ui"),
      { modes: ["chat"] },
      { allowTextActions: enabled },
    );
  let adapter = make();
  const base = `/api/organizations/${organizationUuid("one")}/chat_conversations/${conv}`;
  async function run(
    method: "GET" | "POST",
    suffix: string,
    value?: any,
    urlbase = base,
  ) {
    const r = await adapter({
      method,
      path: urlbase + suffix,
      ...(value === undefined
        ? {}
        : {
            body: Buffer.from(JSON.stringify(value)),
            contentType: "application/json",
          }),
    });
    return {
      status: r.status,
      data: r.body.byteLength
        ? JSON.parse(Buffer.from(r.body).toString())
        : null,
    };
  }
  const sends = () => calls.filter((x) => x.method === "send");
  return {
    run,
    invoke: (request: OfficialUiReadRequest) => adapter(request),
    base,
    calls,
    sends,
    root,
    restart() {
      adapter = make();
    },
    catalog(v: any) {
      catalog = v;
    },
    onSnapshot(callback: () => Promise<void>) {
      beforeSnapshot = callback;
    },
    fail() {
      failSnapshot = true;
    },
    retire() {
      retireSnapshot = true;
    },
    rotate() {
      identity++;
    },
    owner(v: string) {
      owner = v;
    },
    update(text: string, status = "inProgress") {
      conversation = {
        id: conv,
        title: "Synthetic conversation",
        createdAt: 100,
        updatedAt: 101,
        threadId: "fixture-thread",
        mode: "chat",
        providerId: "fixture-provider",
        sessionAuthors: { ownerAccountUuid: "one" },
        turns: [
          {
            id: "turn-local",
            createdAt: 101,
            prompt: "Local deterministic test",
            attachments: [],
            status,
            items: [{ id: "reply-local", type: "agentMessage", text }],
          },
        ],
      };
    },
    temporary() { conversation.incognito = true; },
    appendFollowUp() {
      conversation.turns.push({ id: "turn-follow-up", createdAt: 102, prompt: "Local deterministic test", status: "completed", items: [{ id: "answer-follow-up", type: "agentMessage", text: "Saved follow-up" }] });
    },
    finish() {
      finishSend(conversation);
    },
    replaceTurn() {
      conversation.turns[0].id = "different-new-turn";
    },
    bindDevice() {
      delete conversation.threadId;
      conversation.chatDeviceBinding = {
        version: 1,
        accountScope: owner,
        organizationId: null,
        deviceId: "fixture-device",
        remoteConversationId: "fixture-remote-chat",
        revision: 1,
        permission: "manual",
      };
    },
  };
}

test("original REST retry aliases dispatch the stored prompt through the Chat engine", async (t) => {
  for (const endpoint of ["retry_completion", "retry_completion2"]) {
    const f = fixture(t);
    f.update("Saved answer", "completed");
    const request = {
      prompt: "",
      model: "fixture-model",
      tools: [],
      attachments: [],
      files: [],
      sync_sources: [],
      rendering_mode: "messages",
      parent_message_uuid: "turn-local:user",
      turn_message_uuids: { assistant_message_uuid: "33333333-3333-7333-8333-333333333333" },
    };
    const result = await f.run("POST", `/${endpoint}`, request);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(f.calls.filter((call) => call.method === "retryResponse").map((call) => call.args.slice(0, 2)), [[conv, "turn-local"]]);
    assert.equal(f.sends().length, 0);
  }
  const disabled = fixture(t, false);
  disabled.update("Saved answer", "completed");
  assert.equal((await disabled.run("POST", "/retry_completion", {})).status, 501);
  assert.equal(disabled.calls.filter((call) => call.method === "retryResponse").length, 0);
});
test("runner disabled actions and foreign organization reject without source/dispatch", async (t) => {
  const f = fixture(t, false);
  assert.equal((await f.run("POST", "/completion", body())).status, 501);
  assert.equal(f.calls.length, 0);
  const g = fixture(t);
  assert.equal(
    (
      await g.run(
        "POST",
        "/completion",
        body(),
        g.base.replace(organizationUuid("one"), organizationUuid("two")),
      )
    ).status,
    404,
  );
  assert.equal(g.calls.length, 0);
});
test("runner submits a memory-off Chat once and reconnects to the same completion", async (t) => {
  const f = fixture(t);
  const baseline = body();
  const input = {
    ...baseline,
    create_conversation_params: {
      ...baseline.create_conversation_params,
      chat_memory_mode: "disabled",
    },
  };
  const first = await f.run("POST", "/completion", input);
  assert.equal(first.status, 200);
  assert.equal(f.sends().length, 1);
  assert.equal((f.sends()[0].args[0] as any).memoryDisabled, true);
  const again = await f.run("POST", "/completion", input);
  assert.equal(again.status, 200);
  assert.equal(again.data.operation_id, first.data.operation_id);
  assert.equal((await f.run("POST", "/completion", baseline)).status, 409);
  const alias = {
    ...input,
    completion_request_id: "55555555-5555-4555-8555-555555555555",
  };
  assert.equal(
    (await f.run("POST", "/completion", alias)).data.operation_id,
    first.data.operation_id,
  );
  assert.equal(f.sends().length, 1);
  f.update("Hello");
  f.finish(); // Real send returns the owned turn before incremental snapshot polling.
  await new Promise((resolve) => setImmediate(resolve));
  const a = await f.run(
    "GET",
    `/claudex_completion/${first.data.operation_id}?cursor=0`,
  );
  assert.equal(a.status, 200);
  assert.equal(a.data.done, false);
  assert.ok(
    a.data.events.some(
      (e: any) =>
        e.event === "content_block_delta" && e.data.delta.text === "Hello",
    ),
  );
  f.update("Hello world", "completed");
  const b = await f.run(
    "GET",
    `/claudex_completion/${first.data.operation_id}?cursor=${a.data.cursor}`,
  );
  assert.equal(b.status, 200);
  assert.equal(b.data.done, true);
  assert.ok(b.data.events.some((e: any) => e.event === "message_stop"));
  assert.ok(b.data.events.some((e: any) => e.data.delta?.text === " world"));
  f.finish();
  assert.equal(f.sends().length, 1);
});
test("runner semantic and request-alias conflicts never dispatch twice", async (t) => {
  const f = fixture(t);
  await f.run("POST", "/completion", body());
  assert.equal(
    (await f.run("POST", "/completion", { ...body(), prompt: "Different" }))
      .status,
    409,
  );
  const changed = body();
  changed.turn_message_uuids.human_message_uuid =
    "66666666-6666-7666-8666-666666666666";
  assert.equal((await f.run("POST", "/completion", changed)).status, 409);
  assert.equal(f.sends().length, 1);
});
test("runner restart tombstone reports unknown outcome, never a new send", async (t) => {
  const f = fixture(t);
  await f.run("POST", "/completion", body());
  f.restart();
  const retry = await f.run("POST", "/completion", body());
  assert.equal(retry.status, 409);
  assert.equal(retry.data.error.type, "completion_outcome_unknown");
  assert.equal(f.sends().length, 1);
});
test("runner source failure and late activation change cannot create/send conversation", async (t) => {
  for (const kind of ["fail", "retire"] as const) {
    const f = fixture(t);
    f[kind]();
    const r = await f.run("POST", "/completion", body());
    assert.ok(r.status >= 400);
    assert.equal(f.sends().length, 0);
    assert.doesNotMatch(JSON.stringify(r.data), /private source/);
  }
});
for (const kind of ["unknown", "null", "error"] as const)
  test(`runner ${kind} model source does not dispatch`, async (t) => {
    const f = fixture(t);
    const value = body();
    if (kind === "null") f.catalog(null);
    else if (kind === "error") f.catalog(Error("private catalog error"));
    else {
      value.model = "unknown-model";
      value.create_conversation_params.model = "unknown-model";
    }
    const r = await f.run("POST", "/completion", value);
    assert.ok(r.status >= 400, `${kind} returned ${r.status}`);
    assert.equal(f.sends().length, 0);
  });
test("runner rejects unsupported tools before dispatch and retires prior operation on same-account activation", async (t) => {
  const f = fixture(t);
  assert.equal(
    (
      await f.run("POST", "/completion", {
        ...body(),
        tools: [{ type: "function", name: "untrusted" }],
      })
    ).status,
    501,
  );
  assert.equal(f.sends().length, 0);
  const r = await f.run("POST", "/completion", body());
  assert.equal(r.status, 200);
  f.rotate();
  const poll = await f.run(
    "GET",
    `/claudex_completion/${r.data.operation_id}?cursor=0`,
  );
  assert.equal(poll.status, 409);
  assert.equal(f.sends().length, 1);
});

test("runner concurrent duplicate submissions dispatch at most once", async (t) => {
  const f = fixture(t);
  const responses = await Promise.all([
    f.run("POST", "/completion", body()),
    f.run("POST", "/completion", body()),
    f.run("POST", "/completion", body()),
  ]);
  assert.equal(f.sends().length, 1);
  assert.ok(responses.some((r) => r.status === 200));
  assert.ok(responses.every((r) => r.status === 200 || r.status === 409));
});
test("runner operation poll cannot cross conversation or account", async (t) => {
  const f = fixture(t);
  const r = await f.run("POST", "/completion", body());
  assert.equal(r.status, 200);
  assert.equal(
    (
      await f.run(
        "GET",
        `/claudex_completion/${r.data.operation_id}?cursor=0`,
        undefined,
        f.base.replace(conv, "99999999-9999-7999-8999-999999999999"),
      )
    ).status,
    409,
  );
  f.owner("two");
  assert.equal(
    (await f.run("GET", `/claudex_completion/${r.data.operation_id}?cursor=0`))
      .status,
    404,
  );
  assert.equal(f.sends().length, 1);
});
test("runner catalog More-model is available but absent effort metadata cannot authorize effort", async (t) => {
  const hidden = fixture(t);
  hidden.catalog({
    defaultModel: "fixture-model",
    items: [{ id: "fixture-model", hidden: true, efforts: [] }],
  });
  assert.equal((await hidden.run("POST", "/completion", body())).status, 200);
  assert.equal(hidden.sends().length, 1);
  const noEffort = fixture(t);
  const r = await noEffort.run("POST", "/completion", {
    ...body(),
    effort: "low",
  });
  assert.ok(r.status >= 400);
  assert.equal(noEffort.sends().length, 0);
});

test("runner request-id Stop is tuple-bound, repeat-safe and does not synthesize completion", async (t) => {
  const f = fixture(t);
  const sent = await f.run("POST", "/completion", body());
  f.update("Partial");
  f.finish();
  await new Promise((resolve) => setImmediate(resolve));
  const request = { completion_request_id: body().completion_request_id };
  const stopped = await f.run("POST", "/stop_response", request);
  assert.equal(stopped.status, 204);
  const interrupt = f.calls.filter((c) => c.method === "interrupt");
  assert.equal(interrupt.length, 1);
  assert.deepEqual(interrupt[0].args, [
    conv,
    {
      turnId: "turn-local",
      turnCreatedAt: 101,
      conversationCreatedAt: 100,
      threadId: "fixture-thread",
    },
  ]);
  const repeat = await f.run("POST", "/stop_response", request);
  assert.equal(repeat.status, 204);
  const poll = await f.run(
    "GET",
    `/claudex_completion/${sent.data.operation_id}?cursor=0`,
  );
  assert.equal(poll.data.done, false);
  assert.equal(
    (
      await f.run("POST", "/stop_response", {
        completion_request_id: "99999999-9999-4999-8999-999999999999",
      })
    ).status,
    409,
  );
  const before = f.calls.filter((c) => c.method === "interrupt").length;
  f.replaceTurn();
  assert.equal((await f.run("POST", "/stop_response", request)).status, 409);
  assert.equal(f.calls.filter((c) => c.method === "interrupt").length, before);
  f.rotate();
  assert.equal((await f.run("POST", "/stop_response", request)).status, 409);
  assert.equal(f.calls.filter((c) => c.method === "interrupt").length, before);
});

test("runner Stop cancels a completion during final preparation after the reader aborts", async (t) => {
  const f = fixture(t);
  f.update("Previous reply", "completed");
  let releaseSnapshot!: () => void, reachedSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  const preparing = new Promise<void>((resolve) => { reachedSnapshot = resolve; });
  let snapshots = 0;
  f.onSnapshot(async () => {
    if (++snapshots === 2) {
      reachedSnapshot();
      await snapshotGate;
    }
  });
  const { create_conversation_params, ...input } = body();
  const completion = {
    method: "POST",
    path: f.base + "/completion",
    body: Buffer.from(JSON.stringify(input)),
    contentType: "application/json",
  } satisfies OfficialUiReadRequest;
  const controller = new AbortController();
  const opening = openOfficialCompletion(
    completion,
    controller.signal,
    f.invoke,
    f.invoke,
    () => () => {},
  );
  try {
    await preparing;
    const reader = (await opening).body!.getReader();
    controller.abort();
    await assert.rejects(reader.read(), { name: "AbortError" });
    const stop = { completion_request_id: input.completion_request_id };
    assert.equal((await f.run("POST", "/stop_response", stop)).status, 204);
    assert.equal((await f.run("POST", "/stop_response", stop)).status, 204);
  } finally {
    controller.abort();
    releaseSnapshot();
  }
  const replay = await f.run("POST", "/completion", input);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.done, true);
  assert.equal(replay.data.events.at(-1).data.error.type, "completion_cancelled");
  assert.equal(f.sends().length, 0);
  assert.equal(f.calls.filter(({ method }) => method === "interrupt").length, 0);
});

test("runner Stop during source loading cancels the identified submission only", async (t) => {
  const f = fixture(t);
  const input = body();
  let releaseSnapshot!: () => void, reachedSnapshot!: () => void;
  const gate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  const reached = new Promise<void>((resolve) => { reachedSnapshot = resolve; });
  let snapshots = 0;
  f.onSnapshot(async () => {
    if (++snapshots === 1) {
      reachedSnapshot();
      await gate;
    }
  });
  const opening = f.run("POST", "/completion", input);
  await reached;
  const stop = f.run("POST", "/stop_response", {
    completion_request_id: input.completion_request_id,
  });
  try {
    const unknown = await f.run("POST", "/stop_response", {
      completion_request_id: "99999999-9999-4999-8999-999999999999",
    });
    assert.equal(unknown.status, 409);
  } finally {
    releaseSnapshot();
  }
  assert.equal((await stop).status, 204);
  const result = await opening;
  assert.equal(result.status, 200);
  assert.equal(result.data.done, true);
  assert.equal(result.data.events.at(-1).data.error.type, "completion_cancelled");
  assert.equal(f.sends().length, 0);
  assert.equal(f.calls.filter(({ method }) => method === "interrupt").length, 0);
  const next = {
    ...body(),
    completion_request_id: "55555555-5555-4555-8555-555555555555",
    turn_message_uuids: {
      human_message_uuid: "66666666-6666-4666-8666-666666666666",
      assistant_message_uuid: "77777777-7777-4777-8777-777777777777",
    },
  };
  assert.equal((await f.run("POST", "/completion", next)).status, 200);
  assert.equal(f.sends().length, 1);
  f.update("Later response");
  f.finish();
});

test("runner Stop during replay loading follows a verified request alias", async (t) => {
  const f = fixture(t);
  const input = body();
  assert.equal((await f.run("POST", "/completion", input)).status, 200);
  f.update("Partial");
  f.finish();
  let releaseSnapshot!: () => void, reachedSnapshot!: () => void;
  const gate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  const reached = new Promise<void>((resolve) => { reachedSnapshot = resolve; });
  f.onSnapshot(async () => {
    reachedSnapshot();
    await gate;
  });
  const request = { completion_request_id: "55555555-5555-4555-8555-555555555555" };
  const replay = f.run("POST", "/completion", { ...input, ...request });
  await reached;
  const stop = f.run("POST", "/stop_response", request);
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseSnapshot();
  assert.equal((await replay).status, 200);
  assert.equal((await stop).status, 204);
  assert.equal(f.sends().length, 1);
  assert.deepEqual(f.calls.filter(({ method }) => method === "interrupt").map(({ args }) => args), [
    [conv, {
      turnId: "turn-local",
      turnCreatedAt: 101,
      conversationCreatedAt: 100,
      threadId: "fixture-thread",
    }],
  ]);
});

test("runner Stop during dispatch waits for the exact turn and rejects a replacement", async (t) => {
  for (const replace of [false, true]) {
    const f = fixture(t);
    const input = body();
    assert.equal((await f.run("POST", "/completion", input)).status, 200);
    assert.equal(f.sends().length, 1);
    const pending = f.run("POST", "/stop_response", {
      completion_request_id: input.completion_request_id,
    });
    const beforeBinding = await Promise.race([
      pending.then(({ status }) => status),
      new Promise<void>((resolve) => setImmediate(resolve)),
    ]);
    f.update("Partial");
    f.finish();
    if (replace) {
      f.update("Another answer");
      f.replaceTurn();
    }
    const result = await pending;
    assert.equal(beforeBinding, undefined);
    assert.equal(result.status, replace ? 409 : 204);
    assert.deepEqual(
      f.calls.filter(({ method }) => method === "interrupt").map(({ args }) => args),
      replace ? [] : [
        [conv, {
          turnId: "turn-local",
          turnCreatedAt: 101,
          conversationCreatedAt: 100,
          threadId: "fixture-thread",
        }],
      ],
    );
  }
});

test("runner accepts the original Chat Stop mutation and interrupts only its owned turn", async (t) => {
  const f = fixture(t);
  const completion = body();
  assert.equal((await f.run("POST", "/completion", completion)).status, 200);
  f.update("Partial");
  f.finish();
  assert.equal((await f.run("GET", "")).status, 200);
  const registry = registryFor(path.resolve("build/official-ui"));
  const input = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
  const output = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
  const stop = (version: bigint, value: { intent?: number; stoppingMessageId?: string }) =>
    f.invoke({
      method: "POST",
      path: officialUiActionPath,
      contentType: "application/proto",
      body: toBinary(input, deepCreate(input, {
        header: { conversationId: conv, mutationId: { sessionId: "stop-session", version } },
        action: { case: "stopGeneration", value },
      })),
    });
  const interrupts = () => f.calls.filter(({ method }) => method === "interrupt").map(({ args }) => args);
  const expected = [conv, {
    turnId: "turn-local",
    turnCreatedAt: 101,
    conversationCreatedAt: 100,
    threadId: "fixture-thread",
  }];
  const plain = await stop(1n, { intent: 1 });
  assert.equal(plain.status, 200);
  assert.equal((fromBinary(output, plain.body) as any).ack.outcome.case, "applied");
  const named = { stoppingMessageId: completion.turn_message_uuids.assistant_message_uuid };
  const targeted = await stop(2n, named);
  assert.equal(targeted.status, 200);
  assert.equal((fromBinary(output, targeted.body) as any).ack.outcome.case, "applied");
  assert.deepEqual((await stop(2n, named)).body, targeted.body);
  assert.deepEqual(interrupts(), [expected, expected]);
  f.appendFollowUp();
  const stale = await stop(3n, named);
  assert.equal(stale.status, 200);
  assert.equal((fromBinary(output, stale.body) as any).ack.outcome.case, "error");
  assert.equal((await stop(4n, { intent: 2 })).status, 400);
  assert.deepEqual(interrupts(), [expected, expected]);

  f.update("Partial");
  f.bindDevice();
  const bound = await stop(5n, named);
  assert.equal((fromBinary(output, bound.body) as any).ack.outcome.case, "applied");
  assert.deepEqual(interrupts().at(-1), [conv, {
    turnId: "turn-local",
    turnCreatedAt: 101,
    conversationCreatedAt: 100,
  }]);
});

test("runner restores a list alias and follows up through REST using only the real service ID", async t => {
 const f=fixture(t), alias="88888888-8888-4888-8888-888888888888";
 f.update("Prior saved reply","completed");
 const state=path.join(f.root,"official-ui","accounts",createHash("sha256").update("one").digest("hex"));
 fs.mkdirSync(state,{recursive:true});fs.writeFileSync(path.join(state,"aliases.json"),JSON.stringify([[alias,conv]]));
 const {create_conversation_params,...followUp}=body();
 const base=f.base.replace(conv,alias);
 const sent=await f.run("POST","/completion",followUp,base);assert.equal(sent.status,200,JSON.stringify(sent.data));
 assert.equal(f.sends().length,1);assert.equal((f.sends()[0].args[0] as any).conversationId,conv);assert.equal((f.sends()[0].args[0] as any).newConversationId,undefined);
 const again=await f.run("POST","/completion",followUp);assert.equal(again.status,200);assert.equal(again.data.operation_id,sent.data.operation_id);assert.equal(f.sends().length,1);
 f.appendFollowUp();f.finish();await new Promise(r=>setImmediate(r));
 const poll=await f.run("GET",`/claudex_completion/${sent.data.operation_id}?cursor=0`,undefined,base);
 assert.equal(poll.status,200);assert.equal(poll.data.done,true);assert.equal(poll.data.events.at(-1).event,"message_stop");
 f.restart();const replay=await f.run("POST","/completion",followUp,base);assert.equal(replay.status,409);assert.equal(replay.data.error.type,"completion_outcome_unknown");assert.equal(f.sends().length,1);
});

test("original REST follow-up accepts owned connector metadata without forwarding browser tool definitions", async (t) => {
  const f = fixture(t, true, true);
  f.update("Prior saved reply", "completed");
  const { create_conversation_params, ...followUp } = body();
  for (const tools of [
    [{ ...connectorTool, name: "unknown_tool" }],
    [{ ...connectorTool, name: "disabled_placeholder" }],
    [{ ...connectorTool, mcp_server_url: "https://unowned.test/mcp" }],
    [connectorTool, connectorTool],
  ]) {
    assert.equal((await f.run("POST", "/completion", { ...followUp, tools })).status, 501);
    assert.equal(f.sends().length, 0);
  }
  const tools = [{ ...connectorTool, needs_approval: false, description: "Browser-supplied text" }];
  const sent = await f.run("POST", "/completion", { ...followUp, tools });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const replay = await f.run("POST", "/completion", followUp);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.operation_id, sent.data.operation_id);
  assert.equal(f.sends().length, 1);
  const [send] = f.sends()[0].args;
  assert.ok(send && typeof send === "object");
  assert.ok(!("tools" in send) && !("connectorOverrides" in send));
  f.appendFollowUp();
  f.finish();
  await new Promise((resolve) => setImmediate(resolve));
  const poll = await f.run("GET", `/claudex_completion/${sent.data.operation_id}?cursor=0`);
  assert.equal(poll.data.done, true);
  assert.equal(poll.data.events.at(-1).event, "message_stop");

  const strict = fixture(t);
  assert.equal((await strict.run("POST", "/completion", { ...followUp, tools })).status, 501);
  assert.equal(strict.sends().length, 0);
});


test("temporary REST sends remain in memory and explicit discard removes them", async (t) => {
  const f = fixture(t);
  const request = body();
  request.create_conversation_params.is_temporary = true;
  const first = await f.run("POST", "/completion", request);
  assert.equal(first.status, 200);
  assert.equal((f.sends()[0].args[0] as { incognito?: boolean }).incognito, true);
  const replay = await f.run("POST", "/completion", request);
  assert.equal(replay.status, 200);
  assert.equal(f.sends().length, 1);
  f.update("private response", "completed");
  f.temporary();
  f.finish();
  const exit = await f.run("POST", "/discard_incognito");
  assert.equal(exit.status, 204);
  assert.equal(f.calls.filter(row => row.method === "discardIncognito").length, 1);
  const files = fs.readdirSync(f.root, { recursive: true }).map(String);
  assert.equal(files.some(file => file.includes("receipt")), false);
});
