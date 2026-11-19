import { create, toBinary } from "@bufbuild/protobuf";
import { registryFor } from "../../electron/official-ui/api/timeline";
import { officialUiTimelinePath } from "../../shared/official-ui-web";
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  conversationRestMessages,
  userMessageId,
  assistantMessageId,
  leafMessageId,
} from "../../electron/official-ui/api/conversations";
import type { Conversation, Turn } from "../../shared/types";
const turn = (id: string, text: string, prompt = "Question"): Turn => ({
  id,
  prompt,
  attachments: [],
  status: "completed",
  createdAt: 1000,
  items: [{ id: id + "-item", type: "agentMessage", text }],
});
const chat = (): Conversation => ({
  id: "33333333-3333-4333-8333-333333333333",
  mode: "chat",
  title: "Real saved text",
  providerId: "fixture",
  model: "fixture",
  createdAt: 1000,
  updatedAt: 2000,
  pinned: false,
  archived: false,
  turns: [turn("first", "```html\n<h1>Saved text 中文</h1>\n```")],
});
function setup(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-rest-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const c = chat();
  let owner = "owner",
    identity = 1;
  let hook: (method: string) => void = () => {};
  const calls: string[] = [];
  const run = createRunnerOfficialAdapter(
    {
      account: () => ({
        id: owner,
        email: "fixture@example.invalid",
        name: "Owner",
      }),
      sessionIdentity: () => identity,
      settings: () => ({}),
      stateDirectory: () => root,
      onEvent: () => () => {},
      appVersion: "test",
      log() {},
    } as never,
    async (method, args) => {
      calls.push(method);
      hook(method);
      if (method === "snapshot")
        return { conversations: [{ ...c, turns: [] }], projects: [] };
      if (method === "conversationTurns") {
        assert.equal(args[0], c.id);
        return { turns: c.turns, savedBranches: c.savedBranches ?? [] };
      }
      throw Error("Unexpected fixture method");
    },
    path.resolve("build/official-ui"),
    { modes: ["chat"] },
  );
  return {
    c,
    calls,
    run,
    path: `/api/organizations/${organizationUuid("owner")}/chat_conversations/${c.id}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong`,
    hook(fn: (method: string) => void) {
      hook = fn;
    },
    account() {
      owner = "other";
    },
    session() {
      identity++;
    },
  };
}
const json = (r: any) => JSON.parse(Buffer.from(r.body).toString());
test("REST history exposes exact text/code and two message nodes needed by artifact version gate", async (t) => {
  const f = setup(t);
  const r = await f.run({ method: "GET", path: f.path });
  assert.equal(r.status, 200);
  const body = json(r);
  assert.equal(body.chat_messages.length, 2);
  const [human, assistant] = body.chat_messages;
  assert.equal(human.sender, "human");
  assert.equal(human.text, "Question");
  assert.equal(
    human.parent_message_uuid,
    "00000000-0000-4000-8000-000000000000",
  );
  assert.equal(assistant.sender, "assistant");
  assert.equal(assistant.parent_message_uuid, human.uuid);
  assert.equal(assistant.uuid, assistantMessageId(f.c.turns[0]));
  assert.equal(assistant.content[0].text, f.c.turns[0].items[0].text);
  assert.equal(body.current_leaf_message_uuid, assistant.uuid);
  assert.deepEqual(assistant.attachments, []);
  assert.ok(assistant.content.length > 0);
});
test("saved retry branches share prompt identity, preserve distinct replies and active leaf/index", () => {
  const c = chat();
  c.turns[0].promptVersionId = "question-v1";
  const retry = {
    ...turn("retry", "New answer"),
    promptVersionId: "question-v1",
  };
  c.savedBranches = [{ id: "old", turns: c.turns } as any];
  c.turns = [retry, turn("next", "Follow-up", "Next question")];
  const h = conversationRestMessages(c);
  assert.equal(h.messages.length, 5);
  const user = userMessageId(retry);
  assert.equal(h.messages.filter((m) => m.uuid === user).length, 1);
  assert.equal(
    h.messages.find((m) => m.uuid === assistantMessageId(retry))
      .parent_message_uuid,
    user,
  );
  assert.equal(
    h.messages.find((m) => m.uuid === userMessageId(c.turns[1]))
      .parent_message_uuid,
    assistantMessageId(retry),
  );
  assert.equal(h.refs.get(assistantMessageId(retry))?.active, true);
  assert.equal(h.refs.get("first:assistant")?.active, false);
  assert.equal(leafMessageId(c), "next:assistant");
});
test("unsupported rich and unprojectable error details are explicit failure, never empty-success", async (t) => {
  for (const mode of [
    "tool",
    "attachment",
    "citation",
    "generated",
    "error",
    "restart",
  ]) {
    const f = setup(t),
      turn = f.c.turns[0];
    if (mode === "tool") turn.items.push({ id: "tool", type: "toolCall" });
    if (mode === "attachment") turn.attachments.push({ name: "file" } as any);
    if (mode === "citation") turn.items[0].citations = [{} as any];
    if (mode === "generated") turn.items[0].generatedFiles = [{} as any];
    if (mode === "error") {
      turn.status = "failed";
      turn.error = "Actual failure detail";
    }
    if (mode === "restart") turn.stopReason = "restart";
    const r = await f.run({ method: "GET", path: f.path });
    assert.equal(r.status, 501, mode);
    assert.equal("chat_messages" in json(r), false);
  }
});
test("foreign organization and stale account/session cannot expose saved history", async (t) => {
  const f = setup(t);
  assert.equal(
    (
      await f.run({
        method: "GET",
        path: f.path.replace(
          organizationUuid("owner"),
          organizationUuid("other"),
        ),
      })
    ).status,
    404,
  );
  assert.equal(f.calls.length, 0);
  for (const method of ["snapshot", "conversationTurns"])
    for (const change of ["account", "session"] as const) {
      const f = setup(t);
      f.hook((m) => {
        if (m === method) f[change]();
      });
      const r = await f.run({ method: "GET", path: f.path });
      assert.notEqual(r.status, 200);
      assert.ok(!Buffer.from(r.body).toString().includes("Saved text 中文"));
    }
});
test("limits and identity conflicts fail instead of losing messages", async (t) => {
  const f = setup(t);
  f.c.turns[0].items[0].text = "x".repeat(3 * 1024 * 1024);
  assert.equal((await f.run({ method: "GET", path: f.path })).status, 413);
  const c = chat();
  c.savedBranches = [
    { id: "conflict", turns: [turn("first", "Different content")] } as any,
  ];
  assert.throws(
    () => conversationRestMessages(c),
    /conflicting message identities/,
  );
});

test("reasoning summaries and text retain original block order without fabricated duration", async (t) => {
  const f = setup(t);
  f.c.turns[0].items = [
    {
      id: "r1",
      type: "reasoning",
      text: "Reasoning 中文",
      summary: ["First", "Second"],
    },
    { id: "a1", type: "agentMessage", text: "Answer one" },
    { id: "r2", type: "reasoning", summary: ["Review"] },
    { id: "a2", type: "agentMessage", text: "Answer two" },
  ];
  const r = await f.run({ method: "GET", path: f.path });
  assert.equal(r.status, 200);
  const a = json(r).chat_messages[1];
  assert.deepEqual(
    a.content.map((b: any) => b.type),
    ["thinking", "text", "thinking", "text"],
  );
  assert.equal(a.content[0].thinking, "Reasoning 中文");
  assert.deepEqual(a.content[0].summaries, [
    { summary: "First" },
    { summary: "Second" },
  ]);
  assert.equal(a.content[0].signature, null);
  assert.equal(a.content[0].start_timestamp, undefined);
  assert.equal(a.content[0].stop_timestamp, new Date(0).toISOString());
  assert.equal(a.text, "Answer one\n\nAnswer two");
});
test("partial, canceled, failed and limit turns never claim end_turn success", async (t) => {
  for (const [status, reason, expected] of [
    ["inProgress", undefined, null],
    ["interrupted", undefined, "user_canceled"],
    ["failed", undefined, "error"],
    ["completed", "length", "max_tokens"],
    ["completed", "tool_use_limit", "tool_use_limit"],
    ["completed", "conversation_length_limit", "conversation_length_limit"],
    ["completed", "usage_limit", "usage_limit"],
  ] as const) {
    const f = setup(t);
    f.c.turns[0].status = status;
    f.c.turns[0].stopReason = reason;
    f.c.turns[0].items.unshift({
      id: "r",
      type: "reasoning",
      text: "Partial thinking",
    });
    const r = await f.run({ method: "GET", path: f.path });
    assert.equal(r.status, 200);
    const a = json(r).chat_messages[1];
    assert.equal(a.stop_reason, expected);
    assert.equal(a.content[1].text, f.c.turns[0].items[1].text);
    assert.equal("stop_timestamp" in a.content[0], status !== "inProgress");
  }
});

test("a rich history REST rejection does not block the independent protobuf timeline", async (t) => {
  const f = setup(t);
  f.c.turns[0].items.push({
    id: "tool",
    type: "commandExecution",
    command: "echo local",
    aggregatedOutput: "local",
    status: "completed",
  });
  assert.equal((await f.run({ method: "GET", path: f.path })).status, 501);
  const schema = registryFor(path.resolve("build/official-ui")).getMessage(
    "anthropic.bard.api.v1alpha.StreamTimelineRequest",
  )!;
  const payload = Buffer.from(
    toBinary(schema, create(schema, { conversationId: f.c.id })),
  );
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  const r = await f.run({
    method: "POST",
    path: officialUiTimelinePath,
    contentType: "application/connect+proto",
    body: Buffer.concat([header, payload]),
  });
  assert.equal(r.status, 200);
  assert.match(r.contentType, /application\/connect\+proto/);
  assert.ok(Buffer.from(r.body).includes(Buffer.from("echo local")));
});
