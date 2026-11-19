import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../electron/store/store";
import { storeAttachment } from "../electron/engine/composer-files";
import { registerConversationTurnHandlers } from "../electron/ipc/conversation-turn-handlers";
import { openPolicy } from "../shared/client-policy";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f016-owned-reuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root),
    source = storeAttachment(
      path.join(root, "attachments"),
      "old.txt",
      Buffer.from("owned bytes"),
      openPolicy,
    );
  const conversation: any = {
    id: randomUUID(),
    mode: "chat",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "old",
        prompt: "old",
        attachments: [source],
        items: [],
        status: "completed",
        createdAt: 1,
      },
    ],
  };
  store.conversations.push(conversation);
  const calls: any[] = [],
    handlers = new Map<string, (...args: any[]) => any>();
  const engine: any = {
    send: async (input: any) => {
      calls.push(input);
      return conversation;
    },
  };
  const context: any = {
    store,
    engine,
    activeAccount: { id: "owner" },
    accountActivationIdentity: {},
    accountRetiring: false,
    selectedAttachments: new Map(),
    policy: () => openPolicy,
    allowedFolder() {},
  };
  registerConversationTurnHandlers({
    context,
    handle: (name: string, fn: (...args: any[]) => any) =>
      handlers.set(name, fn),
    cli: {},
    resumable: {},
  } as any);
  const send = (id = source.id) =>
    handlers.get("send")!({
      conversationId: conversation.id,
      text: "reuse",
      mode: "chat",
      attachments: [{ id }],
      providerId: "p",
      model: "m",
    });
  return { root, source, conversation, context, calls, send };
}

test("a same-conversation historical attachment is copied into a fresh owned selection before send", async (t) => {
  const f = fixture(t);
  await f.send();
  assert.equal(f.calls.length, 1);
  const sent = f.calls[0].attachments[0];
  assert.notEqual(sent.id, f.source.id);
  assert.equal(sent.name, f.source.name);
  assert.equal(fs.readFileSync(sent.path, "utf8"), "owned bytes");
  assert.equal(fs.readFileSync(f.source.path, "utf8"), "owned bytes");
});

test("attachment policy and account retirement still prevent historical-file sends", async (t) => {
  for (const mode of ["policy", "retire"]) {
    const f = fixture(t);
    f.context.policy = () => {
      if (mode === "retire") f.context.accountRetiring = true;
      return mode === "policy"
        ? {
            ...openPolicy,
            attachments: { ...openPolicy.attachments, types: [] },
          }
        : openPolicy;
    };
    await assert.rejects(
      f.send(),
      mode === "policy" ? /turned off/i : /account changed/i,
    );
    assert.equal(f.calls.length, 0);
  }
});

test("foreign, conflicting and changed historical files cannot start a send", async (t) => {
  for (const mode of ["foreign", "conflict", "changed"]) {
    const f = fixture(t);
    if (mode === "conflict")
      f.conversation.savedBranches = [
        {
          id: "other",
          turns: [
            {
              ...f.conversation.turns[0],
              attachments: [
                { ...f.source, path: path.join(f.root, "other.txt") },
              ],
            },
          ],
        },
      ];
    if (mode === "changed") fs.writeFileSync(f.source.path, "changed length");
    await assert.rejects(
      f.send(mode === "foreign" ? "other-id" : f.source.id),
      /no longer available/i,
    );
    assert.equal(f.calls.length, 0);
  }
});
