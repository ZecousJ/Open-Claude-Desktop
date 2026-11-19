import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Engine } from "../electron/engine/engine";
import { registerComposerHandlers } from "../electron/ipc/composer";
import { registerConversationManageHandlers } from "../electron/ipc/conversation-manage-handlers";
import { codeSessionState } from "../electron/official-ui/native/code-session-state";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { registerResources } from "../electron/official-ui/native/resources";
import { Store } from "../electron/store/store";
import type { Conversation, Turn } from "../shared/types";

const id = "11111111-1111-4111-8111-111111111111";
const session = "local_" + id;
const turn = (name: string): Turn => ({
  id: name,
  prompt: name,
  status: "completed",
  attachments: [],
  createdAt: 1,
  items: [{ id: "reply", type: "agentMessage", text: name + " answer" }],
});

function fixture(
  t: TestContext,
  options: { queued?: boolean; readOnly?: boolean } = {},
) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-code-clear-folders-"),
  );
  const cwd = fs.mkdirSync(path.join(root, "workspace"), { recursive: true })!;
  const store = new Store(path.join(root, "state"));
  const conversation: Conversation = {
    id,
    cwd,
    mode: "code",
    title: "Code session",
    threadId: "original-thread",
    providerId: "inert",
    model: "inert",
    turns: [turn("first"), turn("second")],
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    sessionAuthors: { ownerAccountUuid: "owner", viewerAccountUuid: "owner" },
  };
  store.conversations.push(conversation);
  store.flush();
  const listeners = new Set<(event: unknown) => void>();
  const publish = (event: unknown) => {
    for (const listener of listeners) listener(event);
  };
  const engine = new Engine(store, "inert", () => "", publish);
  let identity = {};
  const context = {
    store,
    engine,
    activeAccount: { id: "owner" },
    get accountActivationIdentity() {
      return identity;
    },
    accountRetiring: false,
    accountGeneration: () => 1,
    allowedFolder() {
      throw Error("Choose the working folder with the folder picker.");
    },
    push: publish,
  };
  const native = new Map<string, (...args: any[]) => any>();
  const ipc = new Map<string, (...args: any[]) => any>();
  const register = (name: string, fn: (...args: any[]) => any) => {
    ipc.set(name, fn);
  };
  registerComposerHandlers(register, context as never);
  registerConversationManageHandlers({
    context: context as never,
    engineOf: () => engine,
    handle: register,
  });
  const ctx = {
    account: () => context.activeAccount,
    sessionIdentity: () => identity,
    isCurrent: () => true,
    readOnly: options.readOnly,
    stateDirectory: () => store.root,
    localLoadConversation: async (conversationId: string) =>
      structuredClone(
        store.conversations.find((row) => row.id === conversationId),
      ),
    localListConversations: async () => structuredClone(store.conversations),
    localCall: async (name: string, ...args: unknown[]) =>
      name === "snapshot" ? { approvals: [] } : ipc.get(name)!(...args),
    onEvent: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    log() {},
  };
  if (options.queued) {
    codeSessionState(ctx as never).write({
      version: 1,
      queues: [
        [
          id,
          [
            {
              uuid: "queued",
              message: "Hold this",
              state: "queued",
              createdAt: 1,
            },
          ],
        ],
      ],
      messageIds: [],
    });
  }
  const events: { type: string; hasPreClearSession?: boolean }[] = [];
  const host = {
    ctx,
    on(name: string, fn: (...args: any[]) => any) {
      native.set(name, fn);
    },
    emit(_namespace: string, _name: string, event: (typeof events)[number]) {
      events.push(event);
    },
  };
  const close = registerExperimentalCodeSessions(host as never);
  t.after(() => {
    close();
    t.mock.restoreAll();
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  registerResources(host as never);
  return {
    store,
    root,
    conversation,
    events,
    context,
    ipc,
    invoke: (name: string, ...args: unknown[]) => native.get(name)!(...args),
    reopen: () => new Store(store.root).conversation(id),
    retire: () => {
      identity = {};
      context.accountRetiring = true;
    },
  };
}

test("stock Clear and Restore keep the same session and persist its transcript and thread", async (t) => {
  const f = fixture(t);
  const previous = structuredClone(f.conversation.turns);
  f.conversation.rewind = {
    variant: "pending",
    index: 2,
    threadId: "rewind-thread",
    turns: [turn("rewound")],
    at: 1,
  };
  const rewind = structuredClone(f.conversation.rewind);
  const tokens = {
    inputTokens: 27_990,
    outputTokens: 18,
    totalTokens: 28_008,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
  };
  f.conversation.usage = tokens;
  f.conversation.tokenUsage = {
    last: tokens,
    total: tokens,
    modelContextWindow: 100_000,
  };
  assert.equal(
    (await f.invoke("LocalSessions.getContextUsage", session)).totalTokens,
    28_008,
  );
  await f.invoke("LocalSessions.clearSession", session);
  assert.deepEqual(f.reopen().turns, []);
  assert.equal(f.reopen().threadId, undefined);
  assert.equal(f.reopen().rewind, undefined);
  assert.equal(f.reopen().usage, undefined);
  assert.equal(await f.invoke("LocalSessions.getContextUsage", session), null);
  assert.equal(
    (await f.invoke("LocalSessions.getSession", session)).hasPreClearSession,
    true,
  );
  assert.equal(
    f.events.filter((event) => event.type === "cleared").at(-1)
      ?.hasPreClearSession,
    true,
  );
  await f.invoke("LocalSessions.clearSession", session);
  assert.deepEqual(f.reopen().preClearHistory?.turns, previous);
  const transcript = await f.invoke(
    "LocalSessions.resumePreClearSession",
    session,
  );
  assert.deepEqual(
    transcript
      .filter((row: { type: string }) => row.type === "user")
      .map((row: { uuid: string }) => row.uuid),
    ["first:user", "second:user"],
  );
  assert.deepEqual(f.reopen().turns, previous);
  assert.deepEqual(f.reopen().rewind, rewind);
  assert.equal(f.reopen().threadId, "original-thread");
  assert.equal(
    (await f.invoke("LocalSessions.getContextUsage", session)).totalTokens,
    28_008,
  );
  assert.equal(
    await f.invoke("LocalSessions.resumePreClearSession", session),
    null,
  );
});

test("stock first-prompt rewind keeps its separate Undo history", async (t) => {
  const f = fixture(t);
  await f.invoke("LocalSessions.clearSession", session, false);
  assert.equal(f.reopen().preClearHistory, undefined);
  assert.deepEqual(
    f.reopen().rewind?.turns.map((item) => item.id),
    ["first", "second"],
  );
  const restored = await f.invoke("LocalSessions.undoRewind", session);
  assert.equal(restored.transcript.length, 4);
  assert.equal(f.reopen().threadId, "original-thread");
});

test("Restore keeps the follow-up conversation as a saved branch", async (t) => {
  const f = fixture(t);
  await f.invoke("LocalSessions.clearSession", session);
  f.conversation.threadId = "follow-up-thread";
  f.conversation.turns = [turn("follow-up")];
  f.store.flush();
  await f.invoke("LocalSessions.resumePreClearSession", session);
  const restored = f.reopen();
  assert.equal(restored.threadId, "original-thread");
  assert.deepEqual(
    restored.turns.map((item) => item.id),
    ["first", "second"],
  );
  assert.deepEqual(
    restored.savedBranches?.map((branch) => [
      branch.threadId,
      branch.turns.map((item) => item.id),
    ]),
    [["follow-up-thread", ["follow-up"]]],
  );
});

test("Clear preserves a settled first-turn failure without an upstream turn ID", async (t) => {
  const f = fixture(t);
  f.conversation.turns = [{ ...turn("pending-first"), status: "failed" }];
  await f.invoke("LocalSessions.clearSession", session);
  assert.equal(f.reopen().turns.length, 0);
  await f.invoke("LocalSessions.resumePreClearSession", session);
  assert.deepEqual(
    f.reopen().turns.map(({ id, status }) => [id, status]),
    [["pending-first", "failed"]],
  );
});

test("the composer clears an exact /clear and refuses arguments and attachments before dispatch", async (t) => {
  const f = fixture(t);
  const send = (message: string, attachments?: unknown[], typed?: string) =>
    f.invoke(
      "LocalSessions.sendMessage",
      session,
      message,
      [],
      [],
      attachments,
      undefined,
      undefined,
      "original-request",
      undefined,
      typed,
    );
  await assert.rejects(send("/clear now"), /without arguments/);
  await assert.rejects(
    send("/clear", [{ name: "keep.txt" }]),
    /Remove attachments/,
  );
  await assert.rejects(
    send("@/synthetic-folder\n/clear", undefined, "/clear"),
    /folder references/,
  );
  assert.equal(f.reopen().turns.length, 2);
  await send("/clear");
  assert.deepEqual(f.reopen().turns, []);
  assert.equal(f.reopen().preClearHistory?.turns.length, 2);
});

test("Clear leaves saved input and the transcript alone; a disk failure leaves active history untouched", async (t) => {
  const queued = fixture(t, { queued: true });
  await assert.rejects(
    queued.invoke("LocalSessions.clearSession", session),
    /queued/,
  );
  assert.equal(queued.reopen().turns.length, 2);
  const f = fixture(t);
  t.mock.method(f.store, "write", () => {
    throw Error("Cannot write conversation");
  });
  await assert.rejects(
    f.invoke("LocalSessions.clearSession", session),
    /Cannot write conversation/,
  );
  assert.equal(f.conversation.threadId, "original-thread");
  assert.equal(f.reopen().turns.length, 2);
  assert.equal(
    f.events.some((event) => event.type === "cleared"),
    false,
  );
});

test("stock directory listing and grant keep a deduplicated folder in the owned session only", async (t) => {
  const f = fixture(t);
  const folder = path.join(f.root, "add me");
  fs.mkdirSync(path.join(folder, "child"), { recursive: true });
  fs.writeFileSync(path.join(folder, "file.txt"), "file");
  const resolvedPath = fs.realpathSync(folder);
  assert.deepEqual(await f.invoke("FileSystem.listDirectory", folder), {
    resolvedPath,
    directories: ["child"],
  });
  assert.equal(f.reopen().additionalFolders, undefined);
  assert.equal(
    await f.invoke("LocalSessions.addDirectories", session, [folder, folder]),
    true,
  );
  assert.equal(
    await f.invoke("LocalSessions.addDirectories", session, [folder]),
    true,
  );
  assert.deepEqual(f.reopen().additionalFolders, [resolvedPath]);
  assert.deepEqual(f.reopen().codeSessionFolderGrants, [resolvedPath]);
  assert.deepEqual(f.store.localFolderGrants, []);
  assert.deepEqual(
    (await f.invoke("LocalSessions.getSession", session)).additionalDirectories,
    [resolvedPath],
  );
  assert.throws(
    () => f.ipc.get("updateConversation")!(id, { additionalFolders: [folder] }),
    /folder picker/,
  );
});

test("addDirectories refuses a partial batch, running history, and retired or unowned sessions", async (t) => {
  const f = fixture(t);
  const folder = fs.mkdirSync(path.join(f.root, "valid"), { recursive: true })!;
  const missing = path.join(f.root, "missing");
  assert.ok((await f.invoke("FileSystem.listDirectory", missing)).error);
  assert.equal(
    await f.invoke("LocalSessions.addDirectories", session, [folder, missing]),
    false,
  );
  f.conversation.turns[0].status = "inProgress";
  assert.equal(
    await f.invoke("LocalSessions.addDirectories", session, [folder]),
    false,
  );
  f.conversation.turns[0].status = "completed";
  f.conversation.sessionAuthors!.ownerAccountUuid = "another-owner";
  assert.equal(
    await f.invoke("LocalSessions.addDirectories", session, [folder]),
    false,
  );
  await assert.rejects(
    f.invoke("LocalSessions.clearSession", session),
    /not found/,
  );
  f.conversation.sessionAuthors!.ownerAccountUuid = "owner";
  f.retire();
  assert.equal(
    await f.invoke("LocalSessions.addDirectories", session, [folder]),
    false,
  );
  await assert.rejects(
    f.invoke("LocalSessions.clearSession", session),
    /cannot be changed/,
  );
  assert.equal(f.reopen().additionalFolders, undefined);
});
