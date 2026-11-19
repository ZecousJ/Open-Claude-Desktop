/** Bounded REST protocol over inert mocked conversations. Never invokes a real model. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type http from "node:http";
import { Engine } from "../electron/engine/engine";
import type { CodexRPC } from "../electron/engine/rpc";
import type { SendInput } from "../electron/engine/new-conversation";
import { Store } from "../electron/store/store";
import { Sub2ApiError } from "../electron/sub2api/http";
import { openPolicy } from "../shared/client-policy";
import { createRestCompletionRoute } from "../electron/official-ui/api/rest-completion";
import { RestCompletionTextStream } from "../electron/official-ui/api/rest-completion-stream";
import {
  newAdapterScope,
  inAdapterScope,
} from "../electron/official-ui/api/scope";
import {
  organizationUuid,
  type AdapterContext,
} from "../electron/official-ui/api/context";
import type { Conversation, Turn } from "../shared/types";
const conversation = "11111111-1111-4111-8111-111111111111";
const human = "22222222-2222-7222-8222-222222222222",
  assistant = "33333333-3333-7333-8333-333333333333",
  request = "44444444-4444-7444-8444-444444444444";
const turn = (text: string, status: Turn["status"] = "inProgress"): Turn => ({
  id: "real-turn",
  prompt: "hello",
  attachments: [],
  items: [{ id: "answer", type: "agentMessage", text }],
  status,
  createdAt: 1,
});
const body = () => ({
  prompt: "hello",
  model: "model",
  tools: [],
  attachments: [],
  files: [],
  sync_sources: [],
  rendering_mode: "messages",
  turn_message_uuids: {
    human_message_uuid: human,
    assistant_message_uuid: assistant,
  },
  completion_request_id: request,
  create_conversation_params: {
    name: "",
    model: "model",
    include_conversation_preferences: true,
    is_temporary: false,
  },
});
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rest-completion-"));
  t.after(async () => {
    // These fixtures queue real 500 ms adapter-state saves; keep their owned
    // temporary directory alive until the queue runs. Do not hide write errors.
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let owner = "owner",
    identity = {},
    scope = newAdapterScope(owner, root, identity),
    c: Conversation | undefined,
    interruptGate: Promise<void> | undefined,
    interrupts: unknown[][] = [],
    sends = 0,
    reads = 0,
    readFailure = false,
    sendFailure = false;
  const sentInputs: any[] = [];
  let projects: any[] = [],
    snapshotFailure = false;
  let catalogHook: (() => void) | undefined;

  const ctx = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    settings: () => ({
      providers: [{ id: "p", model: "model" }],
      activeProviderId: "p",
    }),
    snapshot: async () => {
      if (snapshotFailure) throw Error("PRIVATE_PROJECT_READ_FAILURE");
      return {
        projects: structuredClone(projects),
        conversations: c ? [structuredClone(c)] : [],
      };
    },
    modelCatalog: async () => (
      catalogHook?.(),
      {
        defaultModel: "model",
        items: [{ id: "model", efforts: ["low"] }],
      }
    ),
    loadConversation: async () => {
      reads++;
      if (readFailure) throw Error("PRIVATE_READ_ERROR");
      return c && structuredClone(c);
    },
    call: async (name: string, input: any, expected?: unknown) => {
      if (name === "interrupt") {
        interrupts.push([input, expected]);
        await interruptGate;
        return { status: "accepted" };
      }
      assert.equal(name, "send");
      sends++;
      sentInputs.push(structuredClone(input));
      if (sendFailure) throw Error("PRIVATE_SEND_ERROR");
      c = {
        ...c,
        id: input.newConversationId ?? input.conversationId,
        mode: "chat",
        title: "Chat",
        ...(input.projectId ? { projectId: input.projectId } : {}),
        pinned: false,
        archived: false,
        providerId: "p",
        model: "model",
        turns: [
          ...(c?.turns ?? []),
          { ...turn("你好"), id: `real-turn-${sends}` },
        ],
        createdAt: 1,
        updatedAt: 1,
      };
      return structuredClone(c);
    },
  } as unknown as AdapterContext;
  let route = createRestCompletionRoute(ctx);
  return {
    ctx,
    sentInputs,
    setProjects(value: any[]) {
      projects = value;
    },
    failProjects() {
      snapshotFailure = true;
    },
    onCatalog(fn: () => void) {
      catalogHook = fn;
    },
    setConversation(value: Conversation) {
      c = value;
    },
    holdInterrupt(gate: Promise<void>) {
      interruptGate = gate;
    },
    get interrupts() {
      return interrupts;
    },
    get sends() {
      return sends;
    },
    get reads() {
      return reads;
    },
    get c() {
      return c!;
    },
    base: () =>
      `/api/organizations/${organizationUuid(owner)}/chat_conversations/${conversation}`,
    removeConversation() {
      c = undefined;
    },
    readFail() {
      readFailure = true;
    },
    sendFail() {
      sendFailure = true;
    },
    restart() {
      scope = newAdapterScope(owner, root, identity);
      route = createRestCompletionRoute(ctx);
    },
    switch() {
      owner = "other";
      identity = {};
      scope = newAdapterScope(owner, root, identity);
    },
    async run(method: string, p: string, input?: unknown) {
      let status = 0,
        result = "";
      const req = Object.assign(new EventEmitter(), {
        method,
        url: p,
        headers: { "content-type": "application/json" },
      }) as unknown as http.IncomingMessage;
      const res = {
        writeHead(n: number) {
          status = n;
        },
        end(value = "") {
          result = value;
        },
      } as unknown as http.ServerResponse;
      const pending = inAdapterScope(scope, () =>
        route(
          req,
          res,
          new URL(p, "http://localhost").pathname,
          new URL(p, "http://localhost"),
        ),
      );
      if (input !== undefined) {
        req.emit("data", Buffer.from(JSON.stringify(input)));
        req.emit("end");
      }
      await pending;
      // Dispatch receipts settle asynchronously; poll after their notification turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { status, data: result ? JSON.parse(result) : null };
    },
  };
}
test("engine chat resolves omitted models from the saved Chat selection on a fresh send", async (t) => {
  const f = fixture(t);
  Object.assign(f.ctx, {
    richQuoteActions: true,
    readModelPreference: () => ({ model: "selected" }),
    modelCatalog: async () => ({ defaultModel: "model", items: [
      { id: "model", sort: 0, efforts: ["low"] },
      { id: "selected", sort: 1, efforts: ["low"] },
    ] }),
    settings: () => ({ providers: [{ id: "p", model: "model", models: ["selected"] }], activeProviderId: "p" }),
  });
  const { model: _model, create_conversation_params, ...rest } = body();
  const { model: _creationModel, ...creation } = create_conversation_params;
  const result = await f.run("POST", f.base() + "/completion", {
    ...rest, effort: "low", create_conversation_params: creation,
  });
  assert.equal(result.status, 200);
  assert.equal(f.sends, 1);
  assert.equal(f.sentInputs[0].model, "selected");
  Object.assign(f.ctx, { readModelPreference: () => ({ model: "model" }) });
  const replay = await f.run("POST", f.base() + "/completion", {
    ...rest, effort: "low", create_conversation_params: creation,
  });
  assert.equal(replay.status, 409);
  assert.equal(f.sends, 1);
});
test("omitted models remain restricted to fresh engine-chat sends", async (t) => {
  const f = fixture(t);
  const { model: _model, create_conversation_params, ...rest } = body();
  const { model: _creationModel, ...creation } = create_conversation_params;
  const omitted = { ...rest, create_conversation_params: creation };
  assert.equal((await f.run("POST", f.base() + "/completion", omitted)).status, 501);
  Object.assign(f.ctx, { richQuoteActions: true, strictActionSemantics: true });
  const mismatch = { ...body(), create_conversation_params: { ...create_conversation_params, model: "other" } };
  assert.equal((await f.run("POST", f.base() + "/completion", mismatch)).status, 400);
  assert.equal((await f.run("POST", f.base() + "/completion", body())).status, 200);
  const changedIds = { human_message_uuid: "55555555-5555-7555-8555-555555555555", assistant_message_uuid: "66666666-6666-7666-8666-666666666666" };
  assert.equal((await f.run("POST", f.base() + "/completion", { ...omitted, completion_request_id: null, turn_message_uuids: changedIds })).status, 409);
  assert.equal((await f.run("POST", f.base() + "/retry_completion", {
    ...rest, prompt: "", parent_message_uuid: "real-turn:assistant", turn_message_uuids: { assistant_message_uuid: changedIds.assistant_message_uuid },
  })).status, 501);
  assert.equal(f.sends, 1);
});
test("one POST produces real incremental events; retry replays from zero without another send", async (t) => {
  const f = fixture(t),
    input = body(),
    post = await f.run("POST", f.base() + "/completion", input);
  assert.equal(post.status, 200);
  assert.equal(f.sends, 1);
  const op = post.data.operation_id;
  let cursor = post.data.cursor;
  const events = [...post.data.events];
  let read = await f.run(
    "GET",
    f.base() + `/claudex_completion/${op}?cursor=${cursor}`,
  );
  assert.equal(read.status, 200);
  events.push(...read.data.events);
  cursor = read.data.cursor;
  assert.equal(read.data.done, false);
  f.c.turns[0] = { ...turn("你好🙂", "completed"), id: f.c.turns[0].id };
  read = await f.run(
    "GET",
    f.base() + `/claudex_completion/${op}?cursor=${cursor}`,
  );
  assert.equal(read.data.done, true);
  events.push(...read.data.events);
  assert.equal(
    events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.text)
      .join(""),
    "你好🙂",
  );
  assert.equal(events[0].data.message.uuid, assistant);
  assert.equal(events[0].data.message.parent_uuid, human);
  assert.equal(events.at(-1).event, "message_stop");
  const replay = await f.run("POST", f.base() + "/completion", input);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.operation_id, op);
  assert.equal(replay.data.cursor, replay.data.events.length);
  assert.equal(f.sends, 1);
  assert.equal(
    (
      await f.run("POST", f.base() + "/completion", {
        ...input,
        prompt: "different",
      })
    ).status,
    409,
  );
  assert.equal(f.sends, 1);
  assert.equal(
    (
      await f.run("POST", f.base() + "/completion", {
        ...input,
        completion_request_id: "55555555-5555-7555-8555-555555555555",
      })
    ).status,
    200,
  );
  assert.equal(f.sends, 1);
  f.restart();
  assert.equal(
    (await f.run("POST", f.base() + "/completion", input)).status,
    409,
  );
  assert.equal(f.sends, 1);
});
test("tools and unsupported options fail before reading or sending; wrong org never accesses source", async (t) => {
  const f = fixture(t);
  assert.equal(
    (
      await f.run("POST", f.base() + "/completion", {
        ...body(),
        tools: [{ type: "repl_v0", name: "repl" }],
      })
    ).status,
    501,
  );
  assert.equal(
    (
      await f.run("POST", f.base() + "/completion", {
        ...body(),
        mystery: true,
      })
    ).status,
    501,
  );
  assert.equal(
    (
      await f.run(
        "POST",
        f.base().replace(organizationUuid("owner"), organizationUuid("other")) +
          "/completion",
        body(),
      )
    ).status,
    404,
  );
  assert.equal(f.reads, 0);
  assert.equal(f.sends, 0);
});
test("load failure is not absence; dispatch failure is terminal error with no replay", async (t) => {
  const f = fixture(t);
  f.readFail();
  const r = await f.run("POST", f.base() + "/completion", body());
  assert.ok(r.status >= 400);
  assert.equal(f.sends, 0);
  assert.ok(!JSON.stringify(r).includes("PRIVATE"));
  const g = fixture(t);
  g.sendFail();
  const first = await g.run("POST", g.base() + "/completion", body());
  assert.equal(first.status, 200);
  const read = await g.run(
    "GET",
    g.base() + `/claudex_completion/${first.data.operation_id}?cursor=0`,
  );
  assert.equal(read.data.done, true);
  assert.equal(read.data.events.at(-1).event, "error");
  assert.ok(!JSON.stringify(read).includes("PRIVATE"));
  await g.run("POST", g.base() + "/completion", body());
  assert.equal(g.sends, 1);
});

test("an imported Chat can send the same draft after confirming resume", async (t) => {
  const f = fixture(t);
  f.setConversation({
    id: conversation,
    mode: "chat",
    title: "Imported Chat",
    providerId: "p",
    model: "model",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    importedSessionResumePending: true,
    turns: [turn("Previous reply", "completed")],
  });
  const draft = { ...body(), create_conversation_params: undefined, parent_message_uuid: "real-turn:assistant" };
  const endpoint = f.base() + "/completion";
  const blocked = await f.run("POST", endpoint, draft);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error.type, "imported_needs_resume_confirm");
  assert.equal(f.sends, 0);
  f.c.importedSessionResumePending = undefined;
  const sent = await f.run("POST", endpoint, draft);
  assert.equal(sent.status, 200);
  assert.equal(f.sends, 1);
});

test("opaque history parent IDs are checked against actual latest assistant; cancel is never success", async (t) => {
  const f = fixture(t);
  await f.run("POST", f.base() + "/completion", body());
  f.c.turns[0] = { ...turn("done", "completed"), id: f.c.turns[0].id };
  const next: any = {
    ...body(),
    turn_message_uuids: {
      human_message_uuid: "66666666-6666-7666-8666-666666666666",
      assistant_message_uuid: "77777777-7777-7777-8777-777777777777",
    },
    completion_request_id: "88888888-8888-7888-8888-888888888888",
    parent_message_uuid: assistant,
  };
  delete next.create_conversation_params;
  const post = await f.run("POST", f.base() + "/completion", next);
  assert.equal(post.status, 200);
  f.c.turns.at(-1)!.status = "interrupted";
  const read = await f.run(
    "GET",
    f.base() + `/claudex_completion/${post.data.operation_id}?cursor=0`,
  );
  assert.equal(read.data.events.at(-1).event, "error");
  assert.equal(
    read.data.events.some((e: any) => e.event === "message_stop"),
    false,
  );
  f.switch();
  assert.equal(
    (
      await f.run(
        "GET",
        f.base() + `/claudex_completion/${post.data.operation_id}?cursor=0`,
      )
    ).status,
    409,
  );
});
test("mapper holds split surrogate tails, batches bounded Unicode and rejects invalid snapshots", () => {
  const stream = new RestCompletionTextStream();
  stream.update(turn("中文\ud83d"), human, assistant, "model");
  stream.update(
    turn("中文🙂" + "中".repeat(10000), "completed"),
    human,
    assistant,
    "model",
  );
  let cursor = 0,
    all: any[] = [];
  while (true) {
    const batch = stream.batch(cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) < 256 * 1024);
    assert.ok(batch.events.length <= 64);
    all.push(...batch.events);
    cursor = batch.cursor;
    if (batch.done) break;
  }
  assert.equal(
    all
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.text)
      .join(""),
    "中文🙂" + "中".repeat(10000),
  );
  for (const bad of [
    turn("\ud83d", "completed"),
    { ...turn("x"), status: "unknown" },
    { ...turn("x"), items: [{ type: "agentMessage", id: "a" }] },
  ]) {
    const s = new RestCompletionTextStream();
    s.update(bad as Turn, human, assistant, "m");
    assert.equal(s.done, true);
    assert.equal(s.events.at(-1)?.event, "error");
  }
  const changed = new RestCompletionTextStream();
  changed.update(turn("prefix"), human, assistant, "m");
  changed.update(turn("different"), human, assistant, "m");
  assert.equal(changed.events.at(-1)?.event, "error");
});

test("request-scoped Stop never interrupts a replacement or unknown request; accepted is not terminal", async (t) => {
  const f = fixture(t);
  const initial = await f.run("POST", f.base() + "/completion", body());
  const stopped = await f.run("POST", f.base() + "/stop_response", {
    completion_request_id: request,
  });
  assert.equal(stopped.status, 204);
  assert.equal(f.interrupts.length, 1);
  assert.deepEqual(f.interrupts[0], [
    conversation,
    { turnId: "real-turn-1", turnCreatedAt: 1, conversationCreatedAt: 1 },
  ]);
  const poll = await f.run(
    "GET",
    f.base() + `/claudex_completion/${initial.data.operation_id}?cursor=0`,
  );
  assert.equal(poll.data.done, false);
  assert.equal(f.c.turns[0].status, "inProgress");
  const unknown = await f.run("POST", f.base() + "/stop_response", {
    completion_request_id: human,
  });
  assert.equal(unknown.status, 409);
  f.c.turns.push({ ...turn("another"), id: "replacement", createdAt: 2 });
  const stale = await f.run("POST", f.base() + "/stop_response", {
    completion_request_id: request,
  });
  assert.equal(stale.status, 409);
  assert.equal(f.interrupts.length, 1);
  const invalid = await f.run("POST", f.base() + "/stop_response", {
    completion_request_id: request,
    override: true,
  });
  assert.equal(invalid.status, 400);
});

test("mapper preserves thinking, summaries and text as ordered official blocks", () => {
  const stream = new RestCompletionTextStream();
  const value = turn("answer", "completed");
  value.items.unshift({
    id: "thinking",
    type: "reasoning",
    text: "reasoning",
    summary: ["summary"],
  });
  stream.update(value, human, assistant, "model");
  assert.equal(stream.done, true);
  assert.deepEqual(
    stream.events
      .filter((e) => e.event === "content_block_start")
      .map((e) => (e.data.content_block as any).type),
    ["thinking", "text"],
  );
  assert.ok(
    stream.events.some((e) => (e.data.delta as any)?.thinking === "reasoning"),
  );
  assert.ok(
    stream.events.some(
      (e) => (e.data.delta as any)?.summary?.summary === "summary",
    ),
  );
  assert.equal(stream.events.at(-1)?.event, "message_stop");
});

test("polling rejects a replaced same-ID conversation and a missing bound source", async (t) => {
  for (const change of ["replace", "remove"]) {
    const f = fixture(t);
    const first = await f.run("POST", f.base() + "/completion", body());
    if (change === "replace") f.c.createdAt = 999;
    else f.removeConversation();
    const poll = await f.run(
      "GET",
      f.base() + `/claudex_completion/${first.data.operation_id}?cursor=0`,
    );
    assert.equal(poll.status, 200);
    assert.equal(poll.data.done, true);
    assert.equal(poll.data.events.at(-1).event, "error");
    assert.equal(f.sends, 1);
  }
});

test("concurrent Stop shares only an in-flight owned request and rejects late replacement", async (t) => {
  const f = fixture(t);
  await f.run("POST", f.base() + "/completion", body());
  let release!: () => void;
  f.holdInterrupt(new Promise<void>((r) => (release = r)));
  const first = f.run("POST", f.base() + "/stop_response", {
    completion_request_id: request,
  });
  const second = f.run("POST", f.base() + "/stop_response", {
    completion_request_id: request,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.interrupts.length, 1);
  release();
  const both = await Promise.all([first, second]);
  assert.deepEqual(
    both.map((v) => v.status),
    [204, 204],
  );
  let releaseAgain!: () => void;
  f.holdInterrupt(new Promise<void>((r) => (releaseAgain = r)));
  const stale = f.run("POST", f.base() + "/stop_response", {
    completion_request_id: request,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.interrupts.length, 2);
  f.c.turns.push({ ...turn("new"), id: "new", createdAt: 2 });
  releaseAgain();
  assert.equal((await stale).status, 409);
  const retry = await f.run("POST", f.base() + "/stop_response", {
    completion_request_id: request,
  });
  assert.equal(retry.status, 409);
  assert.equal(f.interrupts.length, 2);
});

test("failed Stop is not cached and account retirement cannot reuse pending success", async (t) => {
  const f = fixture(t);
  await f.run("POST", f.base() + "/completion", body());
  let reject!: (reason: Error) => void;
  f.holdInterrupt(new Promise<void>((_, r) => (reject = r)));
  const failed = f.run("POST", f.base() + "/stop_response", {
    completion_request_id: request,
  });
  await new Promise((r) => setImmediate(r));
  reject(Error("PRIVATE_STOP_FAILURE"));
  assert.equal((await failed).status, 409);
  f.holdInterrupt(Promise.resolve());
  assert.equal(
    (
      await f.run("POST", f.base() + "/stop_response", {
        completion_request_id: request,
      })
    ).status,
    204,
  );
  assert.equal(f.interrupts.length, 2);
  let release!: () => void;
  f.holdInterrupt(new Promise<void>((r) => (release = r)));
  const retired = f.run("POST", f.base() + "/stop_response", {
    completion_request_id: request,
  });
  await new Promise((r) => setImmediate(r));
  f.switch();
  release();
  assert.equal((await retired).status, 409);
  assert.equal(
    (
      await f.run("POST", f.base() + "/stop_response", {
        completion_request_id: request,
      })
    ).status,
    409,
  );
  assert.equal(f.interrupts.length, 3);
});

test("existing search, research, tool-access and knowledge modes reuse the unchanged engine send", async (t) => {
  for (const patch of [
    { webSearch: true },
    { research: true },
    { toolSearchMode: "off" as const },
    { toolSearchMode: "on" as const },
    { knowledgeBases: ["kb"] },
  ]) {
    const f = fixture(t);
    await f.run("POST", f.base() + "/completion", body());
    f.c.turns[0].status = "completed";
    Object.assign(f.c, patch);
    const { create_conversation_params, ...next } = body();
    next.turn_message_uuids = {
      human_message_uuid: "55555555-5555-7555-8555-555555555555",
      assistant_message_uuid: "66666666-6666-7666-8666-666666666666",
    };
    next.completion_request_id = "77777777-7777-7777-8777-777777777777";
    const accepted = await f.run("POST", f.base() + "/completion", next);
    assert.equal(accepted.status, 200);
    assert.equal(f.sends, 2);
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(patch).map((key) => [key, (f.c as any)[key]]),
      ),
      patch,
    );
  }
});

const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectInput = () => ({
  ...body(),
  create_conversation_params: {
    ...body().create_conversation_params,
    project_uuid: projectA,
  },
});
const readyProject = (id = projectA) => ({
  id,
  kind: "chat",
  name: "Synthetic project",
  instructions: "SYNTHETIC_CONTEXT",
});
const existingProjectChat = () =>
  ({
    id: conversation,
    mode: "chat",
    title: "Synthetic",
    pinned: false,
    archived: false,
    providerId: "p",
    model: "model",
    projectId: projectA,
    turns: [],
    createdAt: 1,
    updatedAt: 1,
  }) as Conversation;
const nextInput = () => {
  const { create_conversation_params, ...rest } = body();
  return rest;
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("shared project chat sends live canonical context and denies revoked follow-ups and retries", async (t) => {
  const f = fixture({ after: fn => t.after(() => {
    store.flush();
    return fn();
  }) });
  const root = f.ctx.stateDirectory!();
  const store = new Store(root);
  store.settings.providers = [{ id: "p", name: "Test", protocol: "responses", baseUrl: "http://127.0.0.1:1/v1", model: "model", models: ["model"] }];
  const engine = new Engine(store, "unused", () => "", () => {});
  engine.ensure = async () => {};
  engine.policy = () => openPolicy;
  engine.windowsSandbox.ensureReady = async () => {};
  const sent: unknown[] = [];
  engine.rpc = {
    async call(method: string, params: unknown) {
      if (method === "thread/start") return { thread: { id: randomUUID() } };
      if (method === "turn/start") {
        sent.push(params);
        return { turn: { id: randomUUID() } };
      }
      return {};
    },
  } as CodexRPC;
  const org = randomUUID();
  const sharedPath = `/api/organizations/${org}/chat_conversations/${conversation}`;
  const servicePath = `/claudex/project-organizations/${org}/projects/${projectA}`;
  const fileId = randomUUID();
  let instructions = "Use the regional forecast format.";
  let knowledge = "North region inventory is 275 units.";
  let role: "view" | "user" | undefined = "view";
  let revokeOnRead = false;
  const notFound = () => new Sub2ApiError(404, "PROJECT_NOT_FOUND", "Project not found.");
  let dispatched: Promise<Conversation> | undefined;
  Object.assign(f.ctx, {
    snapshot: async () => ({ projects: store.projects, conversations: store.conversations }),
    loadConversation: async (id: string) => structuredClone(store.conversations.find(row => row.id === id)),
    organizationProjects: {
      baseUrl: "https://example.invalid",
      async call(route: string) {
        if (!role) throw notFound();
        if (route === servicePath) return { id: projectA, organizationId: org, instructions, role };
        if (route === `${servicePath}/knowledge`)
          return { files: [{ id: fileId, name: "forecast.txt", size: Buffer.byteLength(knowledge) }] };
        throw notFound();
      },
      async readKnowledge(route: string) {
        if (!role || route !== `${servicePath}/knowledge/${fileId}`) throw notFound();
        if (revokeOnRead) role = undefined;
        return Buffer.from(knowledge);
      },
    },
    call(method: string, arg: SendInput | string, ...args: unknown[]) {
      if (method === "send" && typeof arg !== "string") dispatched = engine.send(arg);
      else if (method === "retryResponse" && typeof arg === "string")
        dispatched = engine.retryResponse(arg, String(args[0]), String(args[1]), String(args[2]));
      else throw Error(`Unexpected call ${method}`);
      return dispatched;
    },
  });

  const personal = { ...projectInput(), completion_request_id: randomUUID(), turn_message_uuids: { human_message_uuid: randomUUID(), assistant_message_uuid: randomUUID() } };
  assert.equal((await f.run("POST", f.base() + "/completion", personal)).status, 404);
  assert.equal((await f.run("POST", sharedPath.replace(org, randomUUID()) + "/completion", projectInput())).status, 404);
  const first = await f.run("POST", sharedPath + "/completion", projectInput());
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const created = await dispatched;
  assert.equal(created?.projectOrganizationId, org);
  assert.equal(created?.projectId, projectA);
  const chat = store.conversation(conversation);
  await assert.rejects(engine.steerTurn(conversation, "Continue now", []), /from the shared project/);
  chat.turns[0].status = "completed";
  store.flush();
  assert.equal(new Store(root).conversation(conversation).projectOrganizationId, org);
  assert.match(JSON.stringify(sent[0]), /regional forecast format/);
  assert.match(JSON.stringify(sent[0]), /North region inventory is 275 units/);
  assert.doesNotMatch(JSON.stringify(chat.turns[0]), /regional forecast format|North region inventory/);

  role = "user";
  instructions = "Use the consolidated forecast format.";
  knowledge = "North region inventory is now 290 units.";
  const followUp = () => ({ ...nextInput(), prompt: "What changed in forecast.txt?", completion_request_id: randomUUID(), turn_message_uuids: { human_message_uuid: randomUUID(), assistant_message_uuid: randomUUID() } });
  const next = await f.run("POST", f.base() + "/completion", followUp());
  assert.equal(next.status, 200);
  await dispatched;
  chat.turns[1].status = "completed";
  assert.match(JSON.stringify(sent[1]), /consolidated forecast format/);
  assert.match(JSON.stringify(sent[1]), /North region inventory is now 290 units/);
  assert.equal(store.projects.length, 0);

  const retry = () => ({ ...followUp(), prompt: "", parent_message_uuid: human, turn_message_uuids: { assistant_message_uuid: randomUUID() } });
  instructions = "Use the quarterly forecast format.";
  assert.equal((await f.run("POST", sharedPath + "/retry_completion", retry())).status, 200);
  await dispatched;
  chat.turns.at(-1)!.status = "completed";
  assert.match(JSON.stringify(sent[2]), /quarterly forecast format/);
  await assert.rejects(engine.send({ conversationId: conversation, mode: "chat", text: "Bypass", providerId: "p", model: "model", attachments: [] }), /Open the shared project/);

  revokeOnRead = true;
  const cancelled = await f.run("POST", sharedPath + "/completion", followUp());
  assert.equal(cancelled.status, 200);
  await assert.rejects(dispatched!, /Project not found/);
  assert.equal(sent.length, 3);
  assert.equal((await f.run("POST", f.base() + "/completion", followUp())).status, 404);
  assert.equal((await f.run("POST", sharedPath + "/retry_completion", retry())).status, 404);
  assert.equal(sent.length, 3);
});

test("project REST first send carries the original producer's project_uuid once", async (t) => {
  const f = fixture(t);
  f.setProjects([readyProject()]);
  const first = await f.run("POST", f.base() + "/completion", projectInput());
  await settle();
  assert.equal(first.status, 200);
  assert.equal(f.sentInputs.length, 1);
  assert.equal(f.sentInputs[0].projectId, projectA);
  assert.equal(f.c.projectId, projectA);
  await f.run("POST", f.base() + "/completion", projectInput());
  await settle();
  assert.equal(f.sentInputs.length, 1);
});
test("project REST continuation inherits the durable project association", async (t) => {
  const f = fixture(t);
  f.setProjects([readyProject()]);
  f.setConversation(existingProjectChat());
  const result = await f.run("POST", f.base() + "/completion", nextInput());
  await settle();
  assert.equal(result.status, 200);
  assert.equal(f.sentInputs[0].projectId, projectA);
});
test("project REST rejects invalid, absent, duplicate and non-chat project selections without dispatch", async (t) => {
  for (const [selected, projects, status] of [
    ["bad", [readyProject()], 501],
    [projectA, [], 404],
    [projectA, [readyProject(), readyProject()], 404],
    [projectA, [{ ...readyProject(), kind: "code" }], 404],
    [projectB, [readyProject()], 404],
  ] as const) {
    const f = fixture(t);
    f.setProjects([...projects]);
    const input = projectInput();
    input.create_conversation_params.project_uuid = selected;
    const result = await f.run("POST", f.base() + "/completion", input);
    await settle();
    assert.equal(result.status, status);
    assert.equal(f.sends, 0);
  }
});
test("project REST read failure is not empty context or a provider error leak", async (t) => {
  const f = fixture(t);
  f.failProjects();
  const result = await f.run("POST", f.base() + "/completion", projectInput());
  assert.equal(result.status, 503);
  assert.equal(f.sends, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROJECT/);
});
test("project REST refuses renderer project overrides on an existing conversation", async (t) => {
  for (const extra of [
    { project_uuid: projectB },
    { projectId: projectB },
    {
      create_conversation_params: {
        ...body().create_conversation_params,
        project_uuid: projectB,
      },
    },
  ]) {
    const f = fixture(t);
    f.setProjects([readyProject(), readyProject(projectB)]);
    f.setConversation(existingProjectChat());
    const result = await f.run("POST", f.base() + "/completion", {
      ...nextInput(),
      ...extra,
    });
    await settle();
    assert.ok([501, 409].includes(result.status));
    assert.equal(f.sends, 0);
  }
});
test("project deletion or move while preparing never dispatches stale context", async (t) => {
  for (const change of ["delete", "move", "detach"] as const) {
    const f = fixture(t);
    f.setProjects([readyProject(), readyProject(projectB)]);
    f.setConversation(existingProjectChat());
    f.onCatalog(() => {
      if (change === "delete") f.setProjects([]);
      else f.c.projectId = change === "move" ? projectB : undefined;
    });
    const result = await f.run("POST", f.base() + "/completion", nextInput());
    await settle();
    assert.equal(result.status, 200);
    assert.equal(f.sends, 0);
    const poll = await f.run(
      "GET",
      f.base() +
        "/claudex_completion/" +
        result.data.operation_id +
        "?cursor=0",
    );
    assert.equal(poll.status, 200);
    assert.equal(poll.data.done, true);
    assert.equal(poll.data.events.at(-1).event, "error");
    assert.doesNotMatch(JSON.stringify(poll), /SYNTHETIC_CONTEXT/);
  }
});

test("project REST account retirement and project deletion during catalog preparation never dispatch", async (t) => {
  for (const change of ["account", "deletion"] as const) {
    const f = fixture(t);
    f.setProjects([readyProject()]);
    if (change === "account") f.onCatalog(() => f.switch());
    else f.onCatalog(() => f.setProjects([]));
    const result = await f.run(
      "POST",
      f.base() + "/completion",
      projectInput(),
    );
    assert.equal(f.sends, 0);
    assert.ok(
      change === "account" ? result.status === 409 : result.status === 200,
    );
  }
});
test("project REST null association retains ordinary non-project creation", async (t) => {
  const f = fixture(t);
  const result = await f.run("POST", f.base() + "/completion", {
    ...body(),
    create_conversation_params: {
      ...body().create_conversation_params,
      project_uuid: null,
    },
  });
  assert.equal(result.status, 200);
  assert.equal(f.sends, 1);
  assert.equal(f.sentInputs[0].projectId, undefined);
});
test("project REST attachment executor receives canonical project and deletion after preparation blocks submission", async (t) => {
  for (const remove of [false, true]) {
    const f = fixture(t);
    f.setProjects([readyProject()]);
    f.setConversation(existingProjectChat());
    let submitted = 0;
    f.ctx.prepareCompletionAttachments = async () => {
      if (remove) f.setProjects([]);
      return [
        {
          source: "owned-file",
          id: "owned-synthetic",
          name: "synthetic.txt",
          size: 1,
          kind: "text",
        },
      ];
    };
    f.ctx.submitCompletionWithAttachments = async (input, attachments) => {
      submitted++;
      assert.equal(input.projectId, projectA);
      assert.equal(attachments[0].source, "owned-file");
      return (await f.ctx.call("send", input)) as Conversation;
    };
    const result = await f.run("POST", f.base() + "/completion", {
      ...nextInput(),
      files: ["owned-synthetic"],
    });
    assert.equal(result.status, 200);
    assert.equal(submitted, remove ? 0 : 1);
  }
});
test("project REST retry remains retryResponse and never ordinary send", async (t) => {
  const f = fixture(t);
  f.setProjects([readyProject()]);
  const c = existingProjectChat();
  c.turns = [{ ...turn("previous", "completed"), id: "prior-turn" }];
  f.setConversation(c);
  const { userMessageId } =
    await import("../electron/official-ui/api/conversations");
  const calls: unknown[][] = [];
  f.ctx.call = async (...args) => {
    calls.push(args);
    return c;
  };
  const result = await f.run("POST", f.base() + "/retry_completion", {
    ...nextInput(),
    prompt: "",
    parent_message_uuid: userMessageId(c.turns[0]),
    turn_message_uuids: { assistant_message_uuid: assistant },
  });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "retryResponse");
  assert.equal(calls[0][1], conversation);
});

test("project REST detects project changes while final inventory is awaiting, including no-project to project", async (t) => {
  for (const readOnly of [false, true])
    for (const initial of [projectA, undefined]) {
      const f = fixture(t);
      f.ctx.readOnly = readOnly;
      f.setProjects([readyProject(), readyProject(projectB)]);
      const c = existingProjectChat();
      c.projectId = initial;
      f.setConversation(c);
      f.ctx.loadConversation = async () => f.c; // Deliberately mutable store view.
      if (initial) {
        let reads = 0;
        f.ctx.snapshot = async () => {
          if (++reads === 2) f.c.projectId = projectB;
          return {
            projects: [readyProject(), readyProject(projectB)],
            conversations: [f.c],
          } as any;
        };
      } else
        f.onCatalog(() => {
          f.c.projectId = projectA;
        });
      const result = await f.run("POST", f.base() + "/completion", nextInput());
      assert.equal(result.status, 200);
      assert.equal(f.sends, 0);
    }
});
test("project REST deletion during final snapshot await blocks native and readOnly dispatch", async (t) => {
  for (const readOnly of [false, true]) {
    const f = fixture(t);
    f.ctx.readOnly = readOnly;
    f.setProjects([readyProject()]);
    f.setConversation(existingProjectChat());
    const original = f.ctx.snapshot;
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (reached = r));
    let snapshots = 0;
    f.ctx.snapshot = async (fresh) => {
      if (++snapshots === 2) {
        reached();
        await gate;
      }
      return original(fresh);
    };
    const pending = f.run("POST", f.base() + "/completion", nextInput());
    await ready;
    f.setProjects([]);
    release();
    const result = await pending;
    await settle();
    assert.equal(result.status, 200);
    assert.equal(f.sends, 0);
    const poll = await f.run(
      "GET",
      f.base() + `/claudex_completion/${result.data.operation_id}?cursor=0`,
    );
    assert.equal(poll.data.done, true);
    assert.equal(poll.data.events.at(-1).event, "error");
    assert.equal(
      f.reads,
      1,
      "No later loadConversation can split the final metadata snapshot",
    );
  }
});
test("project REST final snapshot cannot substitute another owner's conversation", async t => {
  const f=fixture(t); f.ctx.readOnly=true; f.setProjects([readyProject()]); f.setConversation(existingProjectChat());
  const original=f.ctx.snapshot;let reads=0;
  f.ctx.snapshot=async fresh=>{ const value=await original(fresh);if(++reads===2)(value.conversations[0] as any).sessionAuthors={ownerAccountUuid:"other-owner"};return value;};
  const result=await f.run("POST",f.base()+"/completion",nextInput());assert.equal(result.status,200);assert.equal(f.sends,0);
});

test("REST completion streams a current MCP prompt and routes its typed response", async (t) => {
  const { ChatElicitationHost } = await import("../electron/official-ui/api/chat-elicitation");
  const f = fixture(t);
  f.setConversation({ id: conversation, mode: "chat", title: "Chat", pinned: false, archived: false, providerId: "p", model: "model", threadId: "thread", turns: [], createdAt: 1, updatedAt: 1 });
  const input = body();
  const { create_conversation_params: _ignored, ...existingInput } = input;
  const post = await f.run("POST", f.base() + "/completion", existingInput);
  assert.equal(post.status, 200);
  const turnId = f.c.turns[0].id;
  f.c.turns[0].items = [
    { id: "answer", type: "agentMessage", text: "你好", status: "completed" },
    { id: "call", type: "mcpToolCall", server: "probe", tool: "ask", status: "inProgress" },
  ];
  const approval = { id: 1, conversationId: conversation, method: "mcpServer/elicitation/request", params: { threadId: "thread", turnId, serverName: "probe", mode: "form", message: "Enter a name", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } };
  let pending = true;
  const sent: unknown[] = [];
  f.ctx.chatElicitation = new ChatElicitationHost({
    isCurrent: () => true,
    load: async () => ({ conversation: f.c, approvals: pending ? [approval] : [] }),
    dispatch: (_a, value) => { sent.push(value); pending = false; },
  });
  const poll = (cursor: number) => f.run("GET", f.base() + `/claudex_completion/${post.data.operation_id}?cursor=${cursor}`);
  const update = await poll(post.data.cursor);
  assert.equal(update.status, 200);
  const offer = update.data.events.find((event: { event: string }) => event.event === "mcp_elicitation");
  assert.equal(offer.data.tool_use_id, `${turnId}:call`);
  const response = await f.run("POST", f.base() + "/mcp_elicitation_result", { elicitation_id: offer.data.elicitation_id, result: JSON.stringify({ action: "accept", content: { name: "Ada" } }) });
  assert.equal(response.status, 200);
  assert.deepEqual(sent, [{ action: "accept", content: { name: "Ada" }, _meta: null }]);
  const finished = await poll(update.data.cursor);
  assert.ok(finished.data.events.some((event: { event: string }) => event.event === "mcp_elicitation_complete"));
});
