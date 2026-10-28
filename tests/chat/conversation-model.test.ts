import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { registerConversationHandlers } from "../../electron/ipc/conversations";

test("Change model: a Code session's model changes for the next message without stopping the turn", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-model-"));
  try {
    const store = new Store(root);
    const base = {
      providerId: "p1",
      model: "gpt-5.5",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    };
    store.conversations.push(
      { ...base, id: "code", title: "Code", mode: "code" },
      { ...base, id: "chat", title: "Chat", mode: "chat" },
    );
    store.settings.providers.push({
      id: "p1",
      name: "One",
      model: "gpt-5.5",
      models: ["gpt-5.5", "gpt-5.5-mini"],
    } as never);
    let stopped = 0;
    const pushed: unknown[] = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerConversationHandlers(
      (name, handler) => handlers.set(name, handler),
      {
        store,
        engine: { stop: async () => void stopped++ } as never,
        replyFeedback: {} as never,
        selectedAttachments: new Map(),
        allowedFolder() {},
        noActive() {
          throw new Error("a model change must not wait for the running turn");
        },
        push: (event: unknown) => void pushed.push(event),
      } as never,
    );
    const update = handlers.get("updateConversation")!;
    update("code", { providerId: "p1", model: "gpt-5.5-mini" });
    assert.equal(store.conversation("code").model, "gpt-5.5-mini");
    assert.equal(new Store(root).conversation("code").model, "gpt-5.5-mini");
    assert.equal(stopped, 0);
    assert.equal(pushed.length, 1);
    assert.throws(
      () => update("code", { providerId: "p1", model: "other" }),
      /cannot use/,
    );
    assert.throws(
      () => update("code", { providerId: "nope", model: "gpt-5.5" }),
      /isn't available/,
    );
    assert.throws(() => update("code", { model: "gpt-5.5" }));
    assert.throws(
      () => update("chat", { providerId: "p1", model: "gpt-5.5" }),
      /Code session/,
    );
    assert.equal(store.conversation("chat").model, "gpt-5.5");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
