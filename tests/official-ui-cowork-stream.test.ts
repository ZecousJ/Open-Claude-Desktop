import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { CodeTranscriptRow } from "../electron/official-ui/native/code-transcript";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";
import type { AppEvent, Conversation, Turn } from "../shared/types";

function fixture() {
  const sessionId = "local_task";
  const window = {};
  const turn: Turn = {
    id: "turn",
    prompt: "Please report progress",
    status: "inProgress",
    createdAt: 1,
    attachments: [],
    items: [],
  };
  const c: Conversation = {
    id: "task",
    mode: "cowork",
    title: "Task",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [turn],
  };
  const handlers = new Map<string, (id: string, options?: unknown) => Promise<any>>();
  const events: any[] = [];
  const windowEvents: any[] = [];
  let listener: ((event: AppEvent) => void) | undefined;
  registerExperimentalCoworkSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      onEvent(fn: (event: AppEvent) => void) { listener = fn; return () => {}; },
      localLoadConversation: async (id: string) => id === c.id ? structuredClone(c) : undefined,
      localCall: async (name: string, id?: string) => {
        if (name === "snapshot") return { approvals: [] };
        assert.equal(name, "interrupt");
        assert.equal(id, c.id);
        turn.status = "interrupted";
        turn.userStopped = true;
        await publish();
      },
      log(...args: unknown[]) { assert.fail(args.join(" ")); },
    },
    caller: window,
    on(name: string, handler: (id: string, options?: unknown) => Promise<any>) { handlers.set(name, handler); },
    emit(domain: string, channel: string, event: unknown) {
      assert.equal(domain, "LocalAgentModeSessions");
      assert.equal(channel, "onEvent");
      events.push(event);
    },
    emitTo(target: object, domain: string, channel: string, event: unknown) {
      assert.equal(target, window);
      assert.equal(domain, "LocalAgentModeSessions");
      assert.equal(channel, "onEvent");
      windowEvents.push(event);
    },
  } as never);
  async function publish() {
    listener!({ type: "conversation", conversation: structuredClone(c) });
    await setImmediate();
  }
  const call = (method: string, options?: unknown) => handlers.get(`LocalAgentModeSessions.${method}`)!(sessionId, options);
  const messages = () => events.filter(event => event.type === "message").map(event => event.message);
  const stream = () => messages().filter(message => message.type === "stream_event").map(message => message.event);
  return { c, turn, events, windowEvents, call, publish, messages, stream };
}

test("Cowork streams partial text before Stop and preserves it once in the stopped transcript", async () => {
  const f = fixture();
  const reply = { id: "reply", type: "agentMessage", text: "Working", lifecycleStatus: "inProgress" } as const;
  f.turn.items = [reply];
  await f.publish();
  await f.publish();
  f.turn.items = [{ ...reply, text: "Working on it" }];
  await f.publish();

  assert.deepEqual(f.stream().map(event => event.type), [
    "message_start", "content_block_start", "content_block_delta", "content_block_delta",
  ]);
  assert.deepEqual(f.stream().flatMap(event => event.delta?.text ?? []), ["Working", " on it"]);
  assert.equal(f.messages().some(message => message.type === "assistant"), false);
  assert.deepEqual((await f.call("getTranscriptRead")).messages.map((row: CodeTranscriptRow) => row.type), ["user"]);

  await f.call("stop");
  await f.publish();
  const replyRows = f.messages().filter(row => row.type === "assistant");
  assert.equal(replyRows.length, 1);
  assert.equal(replyRows[0].message.id, f.stream()[0].message.id);
  assert.deepEqual(replyRows[0].message.content, [{ type: "text", text: "Working on it" }]);
  assert.equal(f.stream().at(-1).type, "message_stop");
  assert.deepEqual(f.events.filter(event => event.type === "close"), [
    { type: "close", sessionId: "local_task", code: 0 },
  ]);
  assert.equal(f.messages().some(message => message.type === "result" || message.isApiErrorMessage), false);
  const history: CodeTranscriptRow[] = (await f.call("getTranscriptRead")).messages;
  assert.deepEqual(history.filter(row => row.type === "assistant"), replyRows);
  assert.deepEqual(history.at(-1)?.message.content, [{ type: "text", text: "[Request interrupted by user]" }]);

  f.c.turns.push({
    id: "followup", prompt: "What is next?", status: "inProgress", createdAt: 2,
    attachments: [], items: [],
  });
  const starting = f.publish();
  const followup = f.c.turns[1];
  followup.items = [{ id: "answer", type: "agentMessage", text: "Next step", lifecycleStatus: "completed" }];
  followup.status = "completed";
  await Promise.all([starting, f.publish()]);
  assert.equal(f.messages().filter(row => row.message?.content[0]?.text === "Working on it").length, 1);
  assert.equal(f.messages().filter(row => row.message?.content[0]?.text === "Next step").length, 1);
  assert.equal(f.messages().at(-1).uuid, "followup:result");
});

test("Cowork keeps text before tools non-terminal and publishes a single normal result", async () => {
  const f = fixture();
  f.turn.items = [{ id: "reply", type: "agentMessage", text: "Checking files", lifecycleStatus: "inProgress" }];
  await f.publish();
  f.turn.items[0].lifecycleStatus = "completed";
  f.turn.items.push({
    id: "command", type: "commandExecution", command: "pwd", lifecycleStatus: "inProgress",
  });
  await f.publish();
  const progress = f.messages().find(row => row.type === "assistant" && row.message.content[0]?.type === "text");
  assert.equal(progress?.message.stop_reason, "pause_turn");
  assert.ok(f.messages().some(row => row.message?.content[0]?.type === "tool_use"));
  assert.equal(f.messages().some(row => row.type === "result"), false);

  Object.assign(f.turn.items[1], { lifecycleStatus: "completed", exitCode: 0, aggregatedOutput: "/repo" });
  f.turn.items.push({ id: "answer", type: "agentMessage", text: "Done", lifecycleStatus: "completed" });
  f.turn.status = "completed";
  await f.publish();
  await f.publish();
  assert.ok(f.messages().some(row => row.message?.content[0]?.type === "tool_result"));
  assert.equal(f.messages().filter(row => row.message?.content[0]?.text === "Checking files").length, 1);
  assert.deepEqual(f.messages().at(-1), {
    type: "result", uuid: "turn:result", session_id: "local_task", parent_tool_use_id: null,
    subtype: "success", is_error: false, stop_reason: "end_turn",
  });
  assert.equal(f.messages().filter(row => row.type === "result").length, 1);
  assert.equal(f.events.some(event => event.type === "close"), false);
});

test("Cowork reopens the transcript while a tool call still has no result", async () => {
  const f = fixture();
  f.turn.items = [{
    id: "lookup", type: "mcpToolCall", status: "inProgress",
    server: "loopback", tool: "lookup", arguments: { term: "fixture" },
  }];
  const { messages }: { messages: CodeTranscriptRow[] } = await f.call("getTranscriptRead");
  assert.deepEqual(messages.map(row => row.type), ["user", "assistant"]);
  const call = messages[1];
  assert.equal(call.type, "assistant");
  assert.ok(Array.isArray(call.message.content));
  assert.equal(call.message.content[0]?.type, "tool_use");
  await f.publish();
  await f.publish();
  assert.equal(f.messages().filter(row => row.uuid === call.uuid).length, 1);
});

test("Cowork reports a failed turn with the partial text and a single error result", async () => {
  const f = fixture();
  f.turn.items = [{ id: "reply", type: "agentMessage", text: "Checking files", lifecycleStatus: "inProgress" }];
  await f.publish();
  f.turn.status = "failed";
  f.turn.error = "The provider disconnected.";
  f.turn.items[0].lifecycleStatus = "failed";
  await f.publish();
  await f.publish();

  const rows = f.messages();
  assert.equal(rows.filter(row => row.message?.content[0]?.text === "Checking files").length, 1);
  assert.equal(rows.filter(row => row.isApiErrorMessage).length, 1);
  assert.deepEqual(rows.filter(row => row.type === "result"), [{
    type: "result", uuid: "turn:result", session_id: "local_task", parent_tool_use_id: null,
    subtype: "error_during_execution", is_error: true, errors: ["The provider disconnected."],
  }]);
  assert.equal(f.events.some(event => event.type === "close"), false);
});

test("reopening a running Cowork session resumes the partial only in the mounting window", async () => {
  const f = fixture();
  f.turn.items = [{ id: "reply", type: "agentMessage", text: "Checking", lifecycleStatus: "inProgress" }];
  await f.publish();
  await f.call("getSession", { skipReplay: true, metadataOnly: true });
  assert.equal(f.windowEvents.length, 0);

  await f.call("getSession", { skipReplay: true });
  assert.deepEqual(f.windowEvents.map(event => event.message.event), f.stream());
  assert.equal(f.windowEvents.length, 3);

  f.turn.items[0].text = "Checking files";
  await f.publish();
  assert.equal(f.stream().at(-1).delta.text, " files");
  assert.equal(f.windowEvents.length, 3);
});
