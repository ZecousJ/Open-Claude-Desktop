import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { createTimelineRpc, registryFor, STREAM_TIMELINE_PATH, waitForConversation } from "../electron/official-ui/api/timeline";
import { guardAdapterContext } from "../electron/official-ui/api/scoped-context";
import { inAdapterScope, newAdapterScope } from "../electron/official-ui/api/scope";
import type { Conversation, ConversationBranch } from "../shared/types";

test("timeline translates rejected model requests in failed branches and preserves quoted JSON", async () => {
  const root = path.resolve("build/official-ui");
  const upstream = {
    error: {
      code: "invalid_request",
      message: "请求参数不符合要求，请检查错误字段和输入内容。",
      type: "invalid_request_error",
    },
  };
  const legacy = `The model service returned HTTP 400: ${JSON.stringify(upstream)}`;
  const wrapped = JSON.stringify({ error: { message: legacy } });
  const turn = { id: "retry", prompt: "Test", attachments: [], createdAt: 1 };
  const failedBranch = (id: string, error: string): ConversationBranch => ({
    id, providerId: "p", model: "m", visited: 1,
    turns: [{ ...turn, id, status: "failed", items: [], error }],
  });
  const conversation: Conversation = {
    id: "model-request", title: "Test", mode: "chat", providerId: "p", model: "m",
    pinned: false, archived: false, createdAt: 1, updatedAt: 1,
    turns: [{
      ...turn, items: [{ id: "quoted", type: "agentMessage", text: wrapped }], status: "completed",
    }],
    savedBranches: [
      failedBranch("failed-current", wrapped),
      failedBranch("failed-legacy", legacy),
      failedBranch("failed-auth", "401 Unauthorized"),
    ],
  };
  const ctx = {
    root, account: () => ({ id: "a" }), settings: () => ({ locale: "zh-Hans" }),
    loadConversation: async () => conversation, onEvent: () => () => {}, log() {},
  };
  const route = createTimelineRpc(ctx as never, { heartbeatMs: 30 });
  const scope = newAdapterScope("a");
  const server = http.createServer((req, res) => inAdapterScope(scope, () => route(req, res, req.url!)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const controller = new AbortController();
  try {
    const schema = registryFor(root).getMessage("anthropic.bard.api.v1alpha.StreamTimelineRequest")!;
    const payload = toBinary(schema, create(schema, { conversationId: conversation.id }));
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.length, 1);
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}${STREAM_TIMELINE_PATH}`, {
      method: "POST", body: Buffer.concat([header, payload]), signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const frame = await response.body!.getReader().read();
    const wire = Buffer.from(frame.value!).toString("utf8");
    assert.equal(wire.split("这条回复未能加载。").length - 1, 2);
    assert.equal(wire.split(wrapped).length - 1, 1);
    assert.equal(wire.includes(legacy), false);
    assert.ok(wire.includes("401 Unauthorized"));
    assert.equal(conversation.savedBranches?.[0].turns[0].error, wrapped);
    assert.equal(conversation.savedBranches?.[1].turns[0].error, legacy);
  } finally {
    controller.abort();
    server.closeAllConnections();
    server.close();
  }
});

test("timeline frames and event callbacks stay with their account and close on account switch", async () => {
  let owner = "a";
  const root = path.resolve("build/official-ui");
  const conversation = (text: string): Conversation => ({
    id: "same-id", title: "Test", mode: "chat", providerId: "p", model: "m", pinned: false, archived: false, createdAt: 1, updatedAt: 1,
    turns: [{ id: "same-turn", prompt: text, attachments: [], items: [], createdAt: 1, status: "completed" }],
  });
  const raw = {
    root, account: () => ({ id: owner }), loadConversation: async () => conversation(owner === "a" ? "ACCOUNT_A_ONLY" : "ACCOUNT_B_ONLY"),
    onEvent: () => () => {}, log() {},
  };
  const ctx = guardAdapterContext(raw as never);
  const scope = newAdapterScope("a");
  const route = createTimelineRpc(ctx, { heartbeatMs: 30 });
  const server = http.createServer((req, res) => inAdapterScope(scope, () => { if (!route(req, res, req.url!)) res.end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const controller = new AbortController();
  try {
    const schema = registryFor(root).getMessage("anthropic.bard.api.v1alpha.StreamTimelineRequest")!;
    const payload = Buffer.from(toBinary(schema, create(schema, { conversationId: "same-id" })));
    const header = Buffer.alloc(5); header.writeUInt32BE(payload.length, 1);
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}${STREAM_TIMELINE_PATH}`, { method: "POST", body: Buffer.concat([header, payload]), signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.ok(Buffer.from(first.value!).includes(Buffer.from("ACCOUNT_A_ONLY")));
    assert.ok(!Buffer.from(first.value!).includes(Buffer.from("ACCOUNT_B_ONLY")));
    owner = "b";
    const rest = await reader.read();
    assert.equal(rest.done, true);
  } finally {
    controller.abort();
    server.closeAllConnections();
    server.close();
  }
});

test("cancelling a pending timeline read removes its account event listener", async () => {
  const listeners = new Set<unknown>();
  const ctx = { loadConversation: async () => undefined,
    onEvent(fn: unknown) { listeners.add(fn); return () => listeners.delete(fn); }, log() {} };
  const controller = new AbortController();
  const result = inAdapterScope(newAdapterScope("a"), () => waitForConversation(ctx as never, "missing", 45_000, controller.signal));
  assert.equal(listeners.size, 1);
  controller.abort();
  assert.equal(await result, undefined);
  assert.equal(listeners.size, 0);
});

test("closing a live HTTP timeline unsubscribes its event listener", async () => {
  const root = path.resolve("build/official-ui");
  const listeners = new Set<unknown>();
  const conversation = { id: "id", title: "Test", mode: "chat", turns: [], createdAt: 1, updatedAt: 1 };
  const ctx = { root, account: () => ({ id: "a" }), loadConversation: async () => conversation,
    onEvent(fn: unknown) { listeners.add(fn); return () => listeners.delete(fn); }, log() {} };
  const route = createTimelineRpc(ctx as never, { heartbeatMs: 30 });
  const scope = newAdapterScope("a");
  const server = http.createServer((req, res) => inAdapterScope(scope, () => { if (!route(req, res, req.url!)) res.end(); }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const schema = registryFor(root).getMessage("anthropic.bard.api.v1alpha.StreamTimelineRequest")!;
    const payload = Buffer.from(toBinary(schema, create(schema, { conversationId: "id" })));
    const header = Buffer.alloc(5); header.writeUInt32BE(payload.length, 1);
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}${STREAM_TIMELINE_PATH}`, { method: "POST", body: Buffer.concat([header, payload]) });
    const reader = response.body!.getReader();
    await reader.read();
    assert.equal(listeners.size, 1);
    await reader.cancel();
    for (let i = 0; i < 100 && listeners.size; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(listeners.size, 0);
  } finally { server.closeAllConnections(); server.close(); }
});
