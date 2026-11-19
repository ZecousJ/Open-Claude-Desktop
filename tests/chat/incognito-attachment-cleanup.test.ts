import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { registerComposerHandlers } from "../../electron/ipc/composer";
import { registerConversationManageHandlers } from "../../electron/ipc/conversation-manage-handlers";
import { interrupt } from "../../electron/engine/engine-handoff";
import { applyTurnEvent } from "../../electron/engine/engine-events";
import { discardIncognitoUploads } from "../../electron/workspace/incognito-upload";
import { openPolicy } from "../../shared/client-policy";
import type { Attachment, Conversation, Turn } from "../../shared/types";

function setup() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-private-cleanup-"),
  );
  const store = new Store(root);
  const selectedAttachments = new Map<string, Attachment>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: string[] = [];
  const feedback: string[] = [];
  let generation = 1;
  const engine: any = {
    interrupt: async () => {
      calls.push("interrupt");
    },
    rpc: {
      call: async () => {
        calls.push("archive");
      },
    },
  };
  const context: any = {
    store,
    engine,
    selectedAttachments,
    accountGeneration: () => generation,
    accountRetiring: false,
    push() {},
    replyFeedback: { deleteConversation: (id: string) => feedback.push(id) },
    policy: () => openPolicy,
  };
  const handle = (name: string, fn: (...args: any[]) => any) =>
    handlers.set(name, fn);
  registerComposerHandlers(handle, context);
  registerConversationManageHandlers({
    handle,
    context,
    engineOf: () => engine as never,
  });
  const upload = (name: string) =>
    handlers.get("addAttachmentData")!(
      name,
      Buffer.from(`self-authored ${name}`),
    ) as Attachment;
  const chat = (
    id: string,
    attachments: Attachment[],
    incognito = false,
  ): Conversation => ({
    id,
    title: id,
    mode: "chat",
    providerId: "default",
    model: "synthetic",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    ...(incognito ? { incognito: true } : {}),
    threadId: `thread-${id}`,
    turns: [
      {
        id: `turn-${id}`,
        prompt: id,
        attachments,
        items: [],
        status: "completed",
        createdAt: 1,
      } as Turn,
    ],
  });
  return {
    root,
    store,
    context,
    engine,
    selectedAttachments,
    calls,
    feedback,
    handlers,
    upload,
    chat,
    discard: (id: string) =>
      handlers.get("discardIncognito")!(id) as Promise<void>,
    retire() {
      generation++;
      context.accountRetiring = true;
    },
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("discard removes private upload copies and selected entries, including saved branches", async () => {
  const env = setup();
  try {
    const privateFile = env.upload("private.txt");
    const savedFile = env.upload("saved-private.txt");
    const shared = env.upload("shared.txt");
    const otherWindowDraft = env.upload("other-window-draft.txt");
    const ordinary = env.chat("ordinary", [shared]);
    const privateChat = env.chat("private", [privateFile, shared], true);
    privateChat.savedBranches = [
      {
        id: "private-old",
        turns: env.chat("old", [savedFile]).turns,
        createdAt: 1,
      } as never,
    ];
    env.store.conversations = [ordinary, privateChat];
    env.store.flush();
    const ordinaryBefore = JSON.stringify(ordinary);
    await env.discard(privateChat.id);
    assert.equal(fs.existsSync(privateFile.path), false);
    assert.equal(fs.existsSync(savedFile.path), false);
    assert.equal(env.selectedAttachments.has(privateFile.id), false);
    assert.equal(env.selectedAttachments.has(savedFile.id), false);
    for (const file of [shared, otherWindowDraft]) {
      assert.equal(
        fs.readFileSync(file.path, "utf8"),
        `self-authored ${file.name}`,
      );
      assert.equal(env.selectedAttachments.get(file.id), file);
    }
    assert.deepEqual(env.store.conversations, [ordinary]);
    assert.equal(JSON.stringify(ordinary), ordinaryBefore);
    assert.deepEqual(env.calls, ["archive"]);
    assert.deepEqual(env.feedback, ["private"]);
    assert.deepEqual(
      new Store(env.root).conversations.map((c) => c.id),
      ["ordinary"],
    );
    await env.discard(privateChat.id);
    assert.deepEqual(env.calls, ["archive"]);
  } finally {
    env.close();
  }
});

test("discard keeps attachments referenced by another incognito window", async () => {
  const env = setup();
  try {
    const shared = env.upload("shared-private.txt");
    const first = env.chat("first", [shared], true);
    const second = env.chat("second", [shared], true);
    env.store.conversations = [first, second];
    await env.discard(first.id);
    assert.equal(fs.existsSync(shared.path), true);
    assert.equal(env.selectedAttachments.get(shared.id), shared);
    assert.deepEqual(env.store.conversations, [second]);
    await env.discard(second.id);
    assert.equal(fs.existsSync(shared.path), false);
    assert.equal(env.selectedAttachments.has(shared.id), false);
  } finally {
    env.close();
  }
});

test("ordinary conversation discard is rejected without deleting its upload", async () => {
  const env = setup();
  try {
    const file = env.upload("ordinary.txt");
    env.store.conversations = [env.chat("ordinary", [file])];
    await assert.rejects(env.discard("ordinary"), /Only incognito/);
    assert.equal(fs.existsSync(file.path), true);
    assert.equal(env.selectedAttachments.get(file.id), file);
    assert.deepEqual(env.calls, []);
  } finally {
    env.close();
  }
});

test("account retirement during archive does not clean the prior conversation", async () => {
  const env = setup();
  try {
    const file = env.upload("private.txt");
    const privateChat = env.chat("private", [file], true);
    env.store.conversations = [privateChat];
    env.engine.rpc.call = async () => {
      env.retire();
    };
    await assert.rejects(env.discard(privateChat.id), /account changed/i);
    assert.equal(fs.existsSync(file.path), true);
    assert.equal(env.selectedAttachments.get(file.id), file);
    assert.deepEqual(env.store.conversations, [privateChat]);
    assert.deepEqual(env.feedback, []);
  } finally {
    env.close();
  }
});

function useRealInterrupt(
  env: ReturnType<typeof setup>,
  terminal: boolean,
  failure?: Error,
) {
  const engine = Object.assign(env.engine, {
    store: env.store,
    elsewhereFor: () => undefined,
    gateway: { abortThread: () => env.calls.push("abort") },
    refusalText: () => undefined,
    changed() {},
    clearApprovals() {},
    recordOutputFiles() {},
    steers: new Map(),
  });
  engine.rpc.call = async (...args: unknown[]) => {
    const method = args[0] as string;
    env.calls.push(method);
    if (method === "turn/interrupt") {
      if (failure) throw failure;
      if (terminal) {
        const c = env.store.conversation("private");
        const turn = c.turns[0];
        applyTurnEvent.call(engine as never, c, turn, "turn/completed", {
          turn: { id: turn.id, status: "interrupted" },
        });
      }
    }
  };
  engine.interrupt = interrupt.bind(engine as never);
}

test("real interrupt rejection or ACK without a terminal event preserves private files and conversation", async () => {
  for (const rejected of [true, false]) {
    const env = setup();
    try {
      const file = env.upload("private-running.txt");
      const privateChat = env.chat("private", [file], true);
      privateChat.turns[0].status = "inProgress";
      env.store.conversations = [privateChat];
      const failure = rejected
        ? Error("Synthetic interrupt refused")
        : undefined;
      useRealInterrupt(env, false, failure);
      await assert.rejects(
        env.discard(privateChat.id),
        failure ?? /still running/,
      );
      assert.equal(privateChat.turns[0].status, "inProgress");
      assert.equal(fs.existsSync(file.path), true);
      assert.equal(env.selectedAttachments.get(file.id), file);
      assert.deepEqual(env.store.conversations, [privateChat]);
      assert.deepEqual(env.feedback, []);
      assert.deepEqual(env.calls, ["turn/interrupt", "abort"]);
    } finally {
      env.close();
    }
  }
});

test("real interrupted terminal event allows discard to clean private uploads", async () => {
  const env = setup();
  try {
    const file = env.upload("private-running.txt");
    const privateChat = env.chat("private", [file], true);
    privateChat.turns[0].status = "inProgress";
    env.store.conversations = [privateChat];
    useRealInterrupt(env, true);
    await env.discard(privateChat.id);
    assert.equal(privateChat.turns[0].status, "interrupted");
    assert.equal(fs.existsSync(file.path), false);
    assert.equal(env.selectedAttachments.has(file.id), false);
    assert.deepEqual(env.store.conversations, []);
    assert.deepEqual(env.calls, ["turn/interrupt", "abort", "thread/archive"]);
  } finally {
    env.close();
  }
});

test("discard cleans an unsent private draft and startup cleanup preserves ordinary files", async () => {
  const env = setup();
  try {
    const ordinary = env.upload("ordinary-draft.txt");
    const first = "00000000-0000-4000-8000-000000015021";
    const second = "00000000-0000-4000-8000-000000015022";
    const privateUpload = (draft: string) => env.handlers.get("addAttachmentData")!(
      "temporary.txt", Buffer.from("private draft"), { incognitoDraft: draft },
    ) as Attachment;
    const one = privateUpload(first), two = privateUpload(second);
    assert.ok(one.path.includes(path.join("attachments", ".incognito", first)));
    await env.handlers.get("discardIncognito")!(first, first);
    assert.equal(fs.existsSync(one.path), false);
    assert.equal(env.selectedAttachments.has(one.id), false);
    assert.equal(fs.existsSync(two.path), true);
    discardIncognitoUploads(env.store.root, new Map());
    assert.equal(fs.existsSync(two.path), false);
    assert.equal(fs.existsSync(ordinary.path), true);
  } finally {
    env.close();
  }
});
