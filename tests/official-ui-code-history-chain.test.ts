/** Actual native history handlers -> actual Engine -> isolated Store; inert SDK boundary. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../electron/engine/engine";
import { Store } from "../electron/store/store";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { codeSessionState } from "../electron/official-ui/native/code-session-state";
import { readClaudeTranscript } from "../electron/conversations/claude-transcripts";
const P = "11111111-1111-4111-8111-111111111111",
  R = "22222222-2222-4222-8222-222222222222",
  S = "local_" + P;
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-f106-chain-")),
    store = new Store(root);
  const c: any = {
    id: P,
    title: "Synthetic history",
    mode: "code",
    cwd: root,
    providerId: "default",
    model: "m",
    threadId: "original",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    sessionAuthors: { ownerAccountUuid: "owner", viewerAccountUuid: "owner" },
    turns: ["one", "two"].map((id) => ({
      id,
      prompt: id,
      status: "completed",
      attachments: [],
      createdAt: 1,
      items: [{ id: "answer", type: "agentMessage", text: id + " answer" }],
    })),
  };
  store.conversations.push(c);
  store.flush();
  const wires: any[] = [],
    calls: any[] = [],
    events: any[] = [],
    listeners = new Set<(v: any) => void>();
  const engine = new Engine(
      store,
      "unused",
      () => "",
      (event) => {
        events.push(event);
        for (const fn of listeners) fn(event);
      },
    ),
    e = engine as any;
  e.ensure = async () => {};
  e.ensureThread = async () => {};
  e.assertModel = () => {};
  e.policy = () => ({});
  e.threadOptions = () => ({ config: {}, developerInstructions: "" });
  e.rpc = {
    call: async (name: string, args: any) => {
      wires.push([name, args]);
      return { thread: { id: "fork-" + wires.length } };
    },
  };
  let generation = 1;
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => generation,
    isCurrent: () => true,
    stateDirectory: () => root,
    localLoadConversation: async (id: string) =>
      structuredClone(store.conversations.find((row) => row.id === id)),
    localListConversations: async () => structuredClone(store.conversations),
    localCall: async (name: string, id: string, arg: any) => {
      calls.push([name, id, arg]);
      const started = generation,
        current = () => started === generation;
      if (name === "forkConversation")
        return engine.forkConversation(
          id,
          arg?.turnId,
          undefined,
          undefined,
          current,
          arg,
        );
      if (name === "rewindConversation")
        return engine.rewindConversation(id, arg, current);
      if (name === "swapRewind") return engine.swapRewind(id, current);
      if (name === "snapshot") return { approvals: [] };
      throw Error("Unexpected " + name);
    },
    onEvent: (fn: any) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    log() {},
  };
  const state = codeSessionState(ctx);
  state.write({
    version: 1,
    queues: [],
    messageIds: [
      [
        P,
        [
          ["one:user", "renderer-one"],
          ["two:user", "renderer-two"],
        ],
      ],
    ],
  });
  const closes: (() => void)[] = [];
  function register() {
    const h = new Map<string, any>();
    closes.push(
      registerExperimentalCodeSessions({
        ctx,
        on: (name: string, fn: any) => h.set(name, fn),
        emit: (_a: string, _b: string, event: any) => events.push(event),
      } as any),
    );
    return h;
  }
  const h = register();
  t.after(() => {
    for (const close of closes) close();
    for (const timer of e.notificationTimer.values()) clearTimeout(timer);
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    c,
    engine,
    e,
    ctx,
    h,
    state,
    wires,
    calls,
    events,
    register,
    reopen: () => new Store(root),
    rotate: () => generation++,
    fork: () => h.get("LocalSessions.forkSession")(S, "local_" + R),
  };
}
test("F106 actual native fork confirms owned clean child, persists both references and never repeats after registration reopen", async (t) => {
  const f = fixture(t);
  f.c.rewind = {
    variant: "forward",
    index: 1,
    turns: [],
    threadId: "old-hidden",
    at: 1,
  };
  const result = await f.fork(),
    id = result.sessionId.slice(6),
    child = f.reopen().conversation(id);
  assert.deepEqual(child.sessionAuthors, f.c.sessionAuthors);
  assert.equal(child.rewind, undefined);
  assert.equal(child.codeNewTask, undefined);
  assert.deepEqual(child.turns, f.c.turns);
  assert.equal(f.reopen().conversation(P).forks?.[0].conversationId, id);
  assert.deepEqual(await f.fork(), result);
  assert.equal(f.wires.length, 1);
  await assert.rejects(
    f.register().get("LocalSessions.forkSession")(S, "local_" + R),
    /not be replayed/,
  );
  assert.equal(f.wires.length, 1);
});

test("forking a confirmed imported message saves its exact prefix before any Codex connection", async (t) => {
  const f = fixture(t);
  const messages = [
    ["user", "imported-user", "Original question"],
    ["assistant", "kept-reply", "Earlier reply"],
    [
      "assistant",
      "imported-tool",
      [
        {
          type: "tool_use",
          id: "tool",
          name: "Read",
          input: { file_path: "note.txt" },
        },
      ],
    ],
    [
      "user",
      "imported-result",
      [{ type: "tool_result", tool_use_id: "tool", content: "Private result" }],
    ],
    ["assistant", "excluded-reply", "Reply after the boundary"],
  ];
  const decoded = readClaudeTranscript(
    messages
      .map(([type, uuid, content], i) =>
        JSON.stringify({
          type,
          uuid,
          sessionId: "cli-id",
          parentUuid: messages[i - 1]?.[1] ?? null,
          message: { role: type, content },
        }),
      )
      .join("\n"),
    "cli-id",
  );
  delete f.c.threadId;
  f.c.turns = decoded.turns;
  f.c.importedHistory = true;
  f.c.importedCliSessionId = "cli-id";
  f.c.importedSessionResumePending = true;
  const fork = () =>
    f.h.get("LocalSessions.forkSession")(S, "local_" + R, "excluded-reply");
  await assert.rejects(fork(), /Confirm that you trust/);
  delete f.c.importedSessionResumePending;
  const result = await fork();
  assert.deepEqual(result, { sessionId: "local_" + R });
  const child = f.reopen().conversation(R);
  assert.equal(child.threadId, undefined);
  assert.equal(child.importedHistory, true);
  assert.equal(child.importedCliSessionId, undefined);
  assert.deepEqual(
    child.turns[0].importedCodeTranscript?.map((row) => row.uuid),
    ["imported-user", "kept-reply", "imported-tool", "imported-result"],
  );
  assert.deepEqual(
    child.turns[0].items
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text),
    ["Earlier reply"],
  );
  assert.deepEqual(
    f
      .reopen()
      .conversation(P)
      .turns[0].items.filter((item) => item.type === "agentMessage")
      .map((item) => item.text),
    ["Earlier reply", "Reply after the boundary"],
  );
  const beforeResult = "33333333-3333-4333-8333-333333333333";
  await f.h.get("LocalSessions.forkSession")(
    S,
    "local_" + beforeResult,
    "imported-result",
  );
  const withoutResult = f.reopen().conversation(beforeResult).turns[0];
  assert.equal(
    withoutResult.importedCodeTranscript?.at(-1)?.uuid,
    "imported-tool",
  );
  assert.equal(
    withoutResult.items.find((item) => item.id === "tool")?.contentItems,
    undefined,
  );
  assert.deepEqual(
    f
      .reopen()
      .conversation(P)
      .forks?.map((branch) => branch.conversationId),
    [R, beforeResult],
  );
  assert.deepEqual(await fork(), result);
  assert.equal(f.wires.length, 0);
  await assert.rejects(
    f.register().get("LocalSessions.forkSession")(
      S,
      "local_" + R,
      "excluded-reply",
    ),
    /not be replayed/,
  );
});
test("F106 renderer user UUID maps exact turn and survives rewind/Undo registration and Store reopen", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.h.get("LocalSessions.rewindV2")(S, "two:user"),
    /boundary/,
  );
  assert.equal(f.wires.length, 0);
  assert.deepEqual(await f.h.get("LocalSessions.rewindV2")(S, "renderer-two"), {
    prefill: "two",
  });
  assert.deepEqual(
    f
      .reopen()
      .conversation(P)
      .turns.map((t) => t.id),
    ["one"],
  );
  const result = await f.register().get("LocalSessions.undoRewind")(S);
  assert.deepEqual(
    result.transcript
      .filter((r: any) => r.type === "user")
      .map((r: any) => r.uuid),
    ["renderer-one", "renderer-two"],
  );
  assert.deepEqual(
    f
      .reopen()
      .conversation(P)
      .turns.map((t) => t.id),
    ["one", "two"],
  );
  assert.deepEqual(await f.h.get("LocalSessions.undoRewind")(S), {
    refusal: "gone",
  });
  assert.equal(f.wires.length, 1);
});
test("F106 duplicate visible UUID and malformed saved rewind refuse before engine dispatch", async (t) => {
  for (const patch of [
    { index: -1 },
    { index: 2.5 },
    { index: 1 },
    { turns: [] },
    { threadId: "" },
  ]) {
    const f = fixture(t);
    f.c.rewind = {
      variant: "pending",
      index: 2,
      turns: [{ ...structuredClone(f.c.turns[1]), id: "removed" }],
      threadId: "old",
      at: 1,
      ...patch,
    };
    await assert.rejects(f.h.get("LocalSessions.undoRewind")(S), /boundary/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(t);
  f.state.write({
    version: 1,
    queues: [],
    messageIds: [
      [
        P,
        [
          ["one:user", "same"],
          ["two:user", "same"],
        ],
      ],
    ],
  });
  await assert.rejects(
    f.h.get("LocalSessions.rewindV2")(S, "same"),
    /ambiguous/,
  );
  assert.equal(f.calls.length, 0);
});
test("F106 settled snapshot cannot start history while the previous Stop is still unconfirmed", async (t) => {
  const f = fixture(t);
  f.c.turns[1].status = "inProgress";
  let resolve!: (v: any) => void;
  const gate = new Promise((r) => (resolve = r)),
    call = f.ctx.localCall;
  f.ctx.localCall = async (name: string, ...args: any[]) =>
    name === "interrupt" ? gate : call(name, ...args);
  const stop = f.h.get("LocalSessions.stop")(S);
  await new Promise((r) => setImmediate(r));
  f.c.turns[1].status = "completed";
  await assert.rejects(f.fork(), /queued Code work/);
  assert.equal(f.wires.length, 0);
  resolve({ status: "already_finished" });
  await stop;
  await f.fork();
  assert.equal(f.wires.length, 1);
});
