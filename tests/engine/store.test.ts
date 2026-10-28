import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import type { Conversation } from "../../shared/types";
test("persists conversations and recovers an interrupted run after relaunch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-store-"));
  try {
    const store = new Store(dir);
    const conversation: Conversation = {
      id: "one",
      title: "中文对话",
      mode: "chat",
      providerId: "default",
      model: "test",
      pinned: true,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [
        {
          id: "turn",
          prompt: "你好",
          attachments: [],
          items: [
            {
              id: "message",
              type: "agentMessage",
              text: "已收到",
              lifecycleStatus: "inProgress",
            },
          ],
          status: "inProgress",
          createdAt: 1,
        },
      ],
    };
    store.conversations.push(conversation);
    store.flush();
    const restored = new Store(dir);
    assert.equal(restored.conversation("one").turns[0].status, "interrupted");
    assert.equal(restored.conversation("one").turns[0].items[0].text, "已收到");
    assert.equal(
      restored.conversation("one").turns[0].items[0].lifecycleStatus,
      "interrupted",
    );
    assert.equal(restored.conversation("one").pinned, true);
    assert.equal(
      fs.existsSync(path.join(dir, "conversations.json.tmp")),
      false,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("corrupt history is preserved and reported instead of silently overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-corrupt-"));
  try {
    fs.writeFileSync(path.join(dir, "conversations.json"), "{broken");
    assert.throws(() => new Store(dir), /did not overwrite/);
    assert.equal(
      fs.readFileSync(path.join(dir, "conversations.json"), "utf8"),
      "{broken",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("separate stores never share mutable provider defaults", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b-"));
  try {
    const storeA = new Store(a);
    storeA.settings.providers[0].model = "changed";
    const fresh = new Store(b);
    assert.equal(fresh.settings.providers[0].model, "");
    assert.equal(fresh.settings.effort, "high");
    assert.equal(fresh.settings.codeEffort, "medium");
    assert.equal(fresh.settings.codeSandbox, "workspace-write");
    assert.equal(fresh.settings.autoAcceptEdits, false);
    assert.equal(fresh.settings.codePlanMode, false);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});
test("existing effort setting initializes the separate Code slider, then explicit Code choice persists", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-effort-migration-"),
  );
  try {
    fs.writeFileSync(
      path.join(root, "settings.json"),
      JSON.stringify({ effort: "high" }),
    );
    const first = new Store(root);
    assert.equal(first.settings.codeEffort, "high");
    first.settings.codeEffort = "ultra";
    first.flush();
    const second = new Store(root);
    assert.equal(second.settings.codeEffort, "ultra");
    assert.equal(second.settings.effort, "high");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("legacy shared sandbox initializes Code separately without later Cowork changes", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-code-sandbox-migration-"),
  );
  try {
    fs.writeFileSync(
      path.join(root, "settings.json"),
      JSON.stringify({ sandbox: "read-only" }),
    );
    const store = new Store(root);
    assert.equal(store.settings.codeSandbox, "read-only");
    store.settings.codeSandbox = "workspace-write";
    store.flush();
    const restored = new Store(root);
    assert.equal(restored.settings.codeSandbox, "workspace-write");
    assert.equal(restored.settings.sandbox, "read-only");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("incognito chats are never written to disk; unread state is", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-incognito-"));
  try {
    const store = new Store(root);
    const base = {
      mode: "chat" as const,
      providerId: "default",
      model: "test",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    };
    store.conversations = [
      { ...base, id: "kept", title: "Kept", unread: true },
      { ...base, id: "secret", title: "Secret", incognito: true },
    ];
    store.flush();
    assert.equal(store.conversations.length, 2, "still shown this session");
    const file = fs.readFileSync(path.join(root, "conversations.json"), "utf8");
    assert.equal(file.includes("Secret"), false);
    const restored = new Store(root);
    assert.deepEqual(
      restored.conversations.map((c) => [c.id, c.unread]),
      [["kept", true]],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
