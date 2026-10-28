import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { registerConversationHandlers } from "../../electron/ipc/conversations";

test("adding an existing chat to a project persists membership and its authorized folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-project-"));
  try {
    const store = new Store(root);
    store.conversations.push({
      id: "chat",
      title: "Synthetic chat",
      mode: "chat",
      providerId: "mock",
      model: "fixture",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    });
    store.projects.push({
      id: "project",
      name: "Fixture",
      description: "",
      instructions: "",
      cwd: root,
      createdAt: 1,
    });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerConversationHandlers(
      (name, handler) => handlers.set(name, handler),
      {
        store,
        engine: {} as never,
        replyFeedback: {} as never,
        selectedAttachments: new Map(),
        allowedFolder(folder) {
          assert.equal(folder, root);
        },
        noActive() {},
      },
    );
    const update = handlers.get("updateConversation")!;
    assert.throws(
      () => update("chat", { projectId: "missing" }),
      /Unknown project/,
    );
    assert.equal(store.conversation("chat").projectId, undefined);
    update("chat", { projectId: "project" });
    const restored = new Store(root).conversation("chat");
    assert.equal(restored.projectId, "project");
    assert.equal(restored.cwd, root);
    update("chat", { projectId: null });
    assert.equal(new Store(root).conversation("chat").projectId, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
