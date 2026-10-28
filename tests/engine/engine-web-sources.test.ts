import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { projectAgentItems } from "../../electron/conversations/agent-transcript-item";
import { openPolicy } from "../../shared/client-policy";
import type { Conversation, Provider } from "../../shared/types";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-web-sources-"));
  const store = new Store(root);
  const c: Conversation = {
    id: "a",
    title: "a",
    mode: "chat",
    providerId: "default",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    threadId: "thread-a",
    webSearch: true,
    turns: [
      {
        id: "turn",
        prompt: "p",
        attachments: [],
        createdAt: 1,
        status: "inProgress",
        items: [],
      },
    ],
  };
  store.conversations = [c];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  const internals = engine as any;
  internals.routes.set("thread-a", "a");
  const notify = (method: string, item: Record<string, unknown>) =>
    internals.notification({
      method,
      params: { threadId: "thread-a", turnId: "turn", item },
    });
  return {
    store,
    engine,
    internals,
    c,
    notify,
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const search = (extra: Record<string, unknown> = {}) => ({
  kind: "search",
  threadId: "thread-a",
  callId: "ws_1",
  tool: "web_search",
  queries: ["capital of france"],
  sources: [{ url: "https://a.example/", title: "A" }],
  status: "completed",
  ...extra,
});

test("search sources wait for the webSearch item with the same id", () => {
  const env = setup();
  try {
    env.internals.signals.webSources(search());
    env.notify("item/started", {
      id: "ws_1",
      type: "webSearch",
      query: "capital of france",
    });
    env.notify("item/completed", {
      id: "ws_1",
      type: "webSearch",
      query: "capital of france",
    });
    const [item] = env.c.turns[0].items;
    assert.deepEqual(item.sources, [{ url: "https://a.example/", title: "A" }]);
    assert.equal(item.searchTool, "web_search");
    assert.equal(item.lifecycleStatus, "completed");
    // A later signal for a known item is written directly.
    env.notify("item/started", { id: "ws_2", type: "webSearch", query: "q" });
    env.internals.signals.webSources(search({ callId: "ws_2", sources: [] }));
    const second = env.c.turns[0].items[1];
    assert.equal(second.sources, undefined, "no sources means no list");
    assert.equal(second.searchTool, "web_search");
  } finally {
    env.close();
  }
});

test("grok's X search, which Codex drops, becomes a finished search item", () => {
  const env = setup();
  try {
    const event = search({
      callId: "xs_1",
      tool: "x_search",
      queries: ["paris", "paris news"],
      sources: [{ url: "https://x.com/a/status/1" }],
    });
    env.internals.signals.webSources(event);
    env.internals.signals.webSources(event);
    assert.equal(env.c.turns[0].items.length, 1, "recorded once");
    assert.deepEqual(env.c.turns[0].items[0], {
      id: "xs_1",
      type: "webSearch",
      query: "paris",
      action: {
        type: "search",
        query: "paris",
        queries: ["paris", "paris news"],
      },
      searchTool: "x_search",
      sources: [{ url: "https://x.com/a/status/1" }],
      status: "completed",
      lifecycleStatus: "completed",
    });
  } finally {
    env.close();
  }
});

test("citations attach to the finished message whose text they index", () => {
  const env = setup();
  try {
    const text = "Paris [a](https://a.example/).";
    const citations = [{ url: "https://a.example/", start: 6, end: 29 }];
    env.internals.signals.webSources({
      kind: "message",
      threadId: "thread-a",
      itemId: "msg_1",
      textLength: text.length,
      textHash: sha(text),
      citations,
    });
    env.notify("item/started", { id: "msg_1", type: "agentMessage", text: "" });
    assert.equal(env.c.turns[0].items[0].citations, undefined);
    assert.equal(env.internals.pendingPatches.size, 1, "waits while streaming");
    env.notify("item/completed", { id: "msg_1", type: "agentMessage", text });
    assert.deepEqual(env.c.turns[0].items[0].citations, citations);
    assert.equal(env.internals.pendingPatches.size, 0);
  } finally {
    env.close();
  }
});

test("citations for a different text are dropped; without an item id the matching message is found", () => {
  const env = setup();
  try {
    env.notify("item/completed", {
      id: "msg_1",
      type: "agentMessage",
      text: "Changed by Codex",
    });
    env.internals.signals.webSources({
      kind: "message",
      threadId: "thread-a",
      itemId: "msg_1",
      textLength: 5,
      textHash: sha("Other"),
      citations: [{ url: "https://a.example/", start: 0, end: 5 }],
    });
    assert.equal(env.c.turns[0].items[0].citations, undefined);
    assert.equal(env.internals.pendingPatches.size, 0);
    const text = "Tokyo [b](https://b.example/)";
    env.notify("item/completed", { id: "msg_x", type: "agentMessage", text });
    env.internals.signals.webSources({
      kind: "message",
      threadId: "thread-a",
      textLength: text.length,
      textHash: sha(text),
      citations: [{ url: "https://b.example/", start: 6, end: text.length }],
    });
    assert.equal(env.c.turns[0].items[1].citations?.length, 1);
  } finally {
    env.close();
  }
});

test("a response's citation list goes on its message; listeners hear every signal", () => {
  const env = setup();
  try {
    const heard: string[] = [];
    env.engine.extensions.add({
      id: "research",
      onGatewaySignal: (signal, target) =>
        heard.push(
          `${signal.type}:${signal.type === "webSources" ? signal.event.kind : ""}:${target.conversation?.id}:${target.turn?.id ?? "-"}`,
        ),
    });
    env.notify("item/completed", {
      id: "msg_b",
      type: "agentMessage",
      text: "x",
    });
    env.internals.signals.webSources({
      kind: "citations",
      threadId: "thread-a",
      responseId: "resp",
      messageId: "msg_b",
      urls: ["https://x.com/a/status/1"],
    });
    assert.deepEqual(env.c.turns[0].items[0].webCitations, [
      "https://x.com/a/status/1",
    ]);
    env.internals.signals.webSources(search({ threadId: "unknown" }));
    assert.deepEqual(heard, [
      "webSources:citations:a:turn",
      "webSources:search:undefined:-",
    ]);
  } finally {
    env.close();
  }
});

test("X search is offered for grok models of the Claudex service unless the policy or catalog says no", () => {
  const env = setup();
  try {
    env.engine.policy = () => openPolicy;
    const provider: Provider = {
      id: "p",
      name: "Claudex",
      baseUrl: "https://claudex.example/v1",
      protocol: "responses",
      backend: "sub2api",
      model: "gpt-5.2",
      models: ["grok-4", "grok-code-fast-1", "gpt-5.2", "notgrok"],
    } as Provider;
    assert.deepEqual(env.engine.requestOptions(provider), {
      describeTools: true,
      xSearchModels: ["grok-4", "grok-code-fast-1"],
    });
    env.engine.searchCapabilities = (_p, model) =>
      model === "grok-4"
        ? { xSearch: false }
        : model === "notgrok"
          ? { xSearch: true }
          : undefined;
    assert.deepEqual(env.engine.requestOptions(provider).xSearchModels, [
      "grok-code-fast-1",
      "notgrok",
    ]);
    env.engine.policy = () =>
      ({ ...openPolicy, research: { enabled: true, xSearch: false } }) as any;
    assert.deepEqual(env.engine.requestOptions(provider).xSearchModels, []);
    env.engine.policy = () => ({ ...openPolicy, webSearch: false });
    assert.deepEqual(env.engine.requestOptions(provider).xSearchModels, []);
    env.engine.policy = () => openPolicy;
    env.engine.searchCapabilities = () => undefined;
    // Other services never get the name-based guess.
    assert.deepEqual(
      env.engine.requestOptions({ ...provider, backend: undefined } as Provider)
        .xSearchModels,
      [],
    );
    assert.deepEqual(
      env.engine.requestOptions({ ...provider, protocol: "chat" })
        .xSearchModels,
      [],
    );
  } finally {
    env.close();
  }
});

test("sources and citations reach the child transcript projection, checked", () => {
  const [search, message] = projectAgentItems([
    {
      id: "ws",
      type: "webSearch",
      searchTool: "x_search",
      sources: [{ url: "https://a.example/" }, { url: "javascript:alert(1)" }],
    },
    {
      id: "m",
      type: "agentMessage",
      text: "abc",
      citations: [
        { url: "https://a.example/", start: 0, end: 3 },
        { url: "https://a.example/", start: 0, end: 30 },
      ],
    },
  ]);
  assert.deepEqual(search.sources, [{ url: "https://a.example/" }]);
  assert.equal(search.searchTool, "x_search");
  assert.deepEqual(message.citations, [
    { url: "https://a.example/", start: 0, end: 3 },
  ]);
});
