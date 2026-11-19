import assert from "node:assert/strict";
import { test } from "node:test";
import { interrupt } from "../electron/engine/engine-handoff";

function fixture(mode = "chat", status = "inProgress") {
  const turn = { id: "self-turn", status, items: [{ id: "self-text", type: "agentMessage", text: "Self-authored partial text." }] };
  const conversation = { id: "self-chat", mode, threadId: "self-thread", turns: [turn] };
  let aborted = 0;
  const engine: any = { store: { conversation: () => conversation }, elsewhereFor: () => undefined,
    gateway: { abortThread: (id: string) => { assert.equal(id, "self-thread"); aborted++; } } };
  return { engine, conversation, turn, run: () => interrupt.call(engine, "self-chat"), aborted: () => aborted };
}

test("Chat missing RPC refuses Stop without inventing terminal success or losing partial content", async () => {
  const f = fixture(), before = structuredClone(f.conversation);
  await assert.rejects(f.run(), /The Codex engine is not connected\./);
  assert.deepEqual(f.conversation, before);
  assert.equal(f.aborted(), 1, "existing owned upstream cleanup remains intact");
});

test("Chat connected RPC acceptance remains pending until a real terminal event", async () => {
  const f = fixture(); const calls: unknown[] = [];
  f.engine.rpc = { call: async (method: string, params: unknown) => { calls.push([method, params]); return {}; } };
  await f.run();
  assert.deepEqual(calls, [["turn/interrupt", { threadId: "self-thread", turnId: "self-turn" }]]);
  assert.equal(f.turn.status, "inProgress"); assert.equal(f.aborted(), 1);
});

test("completed Chat and setup-abort precedence remain unchanged without RPC", async () => {
  const completed = fixture("chat", "completed"); await completed.run(); assert.equal(completed.aborted(), 0);
  const preparing = fixture(); let stoppedSetup = 0;
  preparing.engine.setupAbort = { conversationId: "self-chat", abort: { abort: () => stoppedSetup++ } };
  await preparing.run(); assert.equal(stoppedSetup, 1); assert.equal(preparing.aborted(), 0);
});

test("Code missing RPC also refuses Stop without inventing terminal success", async () => {
  const f = fixture("code"), before = structuredClone(f.conversation);
  await assert.rejects(f.run(), /The Codex engine is not connected\./);
  assert.equal(f.aborted(), 1);
  assert.deepEqual(f.conversation, before);
});

