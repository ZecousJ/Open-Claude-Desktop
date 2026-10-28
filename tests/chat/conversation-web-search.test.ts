import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { registerConversationHandlers } from "../../electron/ipc/conversations";
import { openPolicy } from "../../shared/client-policy";

test("web search choice persists per conversation and refreshes only an idle Responses engine", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-search-"));
  try {
    const store = new Store(root);
    store.settings.providers = [
      {
        id: "responses",
        name: "Local Responses",
        protocol: "responses",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "mock",
        models: [],
      },
      {
        id: "chat",
        name: "Local Chat",
        protocol: "chat",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "mock",
        models: [],
      },
    ];
    store.conversations.push({
      id: "one",
      title: "Synthetic",
      mode: "chat",
      providerId: "responses",
      model: "mock",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    });
    let stopped = 0,
      busy = false,
      policy = openPolicy;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerConversationHandlers(
      (name, handler) => handlers.set(name, handler),
      {
        store,
        engine: {
          stop: async () => {
            stopped++;
          },
          policy: () => policy,
        } as never,
        replyFeedback: {} as never,
        selectedAttachments: new Map(),
        allowedFolder() {},
        noActive() {
          if (busy) throw Error("Busy.");
        },
      },
    );
    const choose = handlers.get("setConversationWebSearch")!;
    await choose("one", true);
    assert.equal(new Store(root).conversation("one").webSearch, true);
    assert.equal(stopped, 1);
    await choose("one", true);
    assert.equal(stopped, 1);
    busy = true;
    await assert.rejects(
      Promise.resolve().then(() => choose("one", false)),
      /Busy/,
    );
    assert.equal(store.conversation("one").webSearch, true);
    busy = false;
    store.conversation("one").research = true;
    await choose("one", false);
    assert.equal(new Store(root).conversation("one").webSearch, false);
    assert.equal(new Store(root).conversation("one").research, undefined);
    assert.equal(stopped, 2);
    store.conversation("one").providerId = "chat";
    await assert.rejects(
      Promise.resolve().then(() => choose("one", true)),
      /Responses-compatible/,
    );
    assert.equal(stopped, 2);
    await choose("one", true, "responses", "mock");
    assert.equal(new Store(root).conversation("one").providerId, "responses");
    assert.equal(new Store(root).conversation("one").webSearch, true);
    assert.equal(stopped, 3);
    // Turned off by the administrator: it can be switched off, never on.
    policy = { ...openPolicy, webSearch: false };
    await choose("one", false);
    assert.equal(stopped, 4);
    await assert.rejects(
      Promise.resolve().then(() => choose("one", true, "responses", "mock")),
      /administrator has turned off web search/,
    );
    assert.equal(store.conversation("one").webSearch, false);
    policy = openPolicy;
    store.conversation("one").mode = "code";
    await assert.rejects(
      Promise.resolve().then(() => choose("one", true)),
      /Chat and Cowork/,
    );
    assert.equal(stopped, 4);
    store.conversation("one").mode = "chat";
    store.settings.mcpServers = { search: { command: "search-server" } };
    await choose("one", true, "responses", "mock");
    store.conversation("one").research = true;
    await choose("one", false);
    assert.equal(new Store(root).conversation("one").research, true);
    assert.equal(new Store(root).conversation("one").webSearch, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
