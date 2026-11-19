import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { RestCompletionTextStream } from "../electron/official-ui/api/rest-completion-stream";
import { openOfficialCompletion } from "../shared/official-completion-stream";
import { protectedToolFailure } from "./support/f040-auth-rejection";
import { completionBlocks } from "../electron/official-ui/api/completion-content";
import { conversationRestMessages } from "../electron/official-ui/api/conversations";
import { conversationUpdate } from "../electron/official-ui/api/timeline";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
import { knownFile } from "../electron/official-ui/api/files";
import type { Turn, Item, Conversation } from "../shared/types";
const turn = (items: Item[], status: Turn["status"] = "completed"): Turn => ({
  id: "turn",
  prompt: "hello",
  attachments: [],
  createdAt: 1,
  items,
  status,
});
const sample: Item[] = [
  {
    id: "thought",
    type: "reasoning",
    text: "Recorded thought",
    summary: ["Recorded summary"],
    lifecycleStatus: "completed",
  },
  {
    id: "tool",
    type: "mcpToolCall",
    tool: "docs.search",
    input: { query: "test" },
    result: { content: [{ type: "text", text: "actual result" }] },
    status: "completed",
  },
  { id: "reply", type: "agentMessage", text: "Recorded reply" },
];
function stream(value: Turn) {
  const s = new RestCompletionTextStream();
  s.update(value, "human", "assistant", "model");
  return s;
}
function actualReducer() {
  const file =
    ".restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1/shared-0-BgsOqC85.js";
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const node = ast.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "cZ",
  );
  assert.ok(node);
  return vm.runInNewContext(`(${node.getText(ast)})()`, {
    jm: function (this: any, callbacks: any) {
      return callbacks;
    },
    Iq: (s: string) => s.length,
    Date,
    Map,
  });
}
function reduce(s: RestCompletionTextStream) {
  const reducer = actualReducer(),
    blocks: any[] = [];
  for (const event of s.events) {
    const e: any = event.data;
    if (e.type === "content_block_start")
      blocks[e.index] = reducer.createBlockFromStartEvent(structuredClone(e));
    if (e.type === "content_block_delta")
      blocks[e.index] = reducer.applyDeltaEvent(e, blocks[e.index]);
    if (e.type === "content_block_stop")
      blocks[e.index] = reducer.stopBlockEvent(e, blocks[e.index]);
    if (e.type === "content_block_retract") blocks.length = e.from_index;
  }
  return blocks;
}
test("a retry replaces only its unfinished text in the existing completion", () => {
  const stream = new RestCompletionTextStream();
  const prefix: Item = {
    id: "preface",
    type: "agentMessage",
    text: "Before retry",
    lifecycleStatus: "completed",
  };
  stream.update(turn([prefix, {
    id: "partial",
    type: "agentMessage",
    text: "Interrupted output",
    lifecycleStatus: "inProgress",
  }], "inProgress"), "human", "assistant", "model");
  assert.deepEqual(reduce(stream).map(block => block.text), [
    "Before retry", "Interrupted output",
  ]);
  stream.update(turn([prefix, {
    id: "replacement",
    type: "agentMessage",
    text: "Recovered reply",
  }]), "human", "assistant", "model");
  assert.deepEqual(reduce(stream).map(block => block.text), [
    "Before retry", "Recovered reply",
  ]);
  assert.equal(stream.events.filter(event => event.event === "message_start").length, 1);
  assert.equal(stream.events.at(-1)?.event, "message_stop");
});
test("actual pinned Chat reducer consumes recorded thinking/tool/text blocks without invoking tools", () => {
  const s = stream(turn(sample));
  assert.equal(s.events.at(-1)?.event, "message_stop");
  const blocks = reduce(s);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["thinking", "tool_use", "tool_result", "text"],
  );
  assert.equal(blocks[0].thinking, "Recorded thought");
  assert.equal(blocks[0].summaries[0].summary, "Recorded summary");
  assert.equal(blocks[1].name, "docs.search");
  assert.deepEqual(JSON.parse(blocks[1].buffered_input), { query: "test" });
  assert.deepEqual(JSON.parse(blocks[1].partial_json), { query: "test" });
  assert.equal(blocks[2].tool_use_id, blocks[1].id);
  assert.equal(blocks[2].is_error, false);
  assert.match(blocks[2].content[0].text, /actual result/);
  assert.equal(blocks[3].text, "Recorded reply");
});
test("running tools do not invent results and later terminal snapshots emit once", () => {
  const s = new RestCompletionTextStream();
  const active = turn(
    [
      {
        id: "tool",
        type: "dynamicToolCall",
        tool: "search",
        arguments: {},
        status: "inProgress",
      },
    ],
    "inProgress",
  );
  s.update(active, "h", "a", "m");
  assert.equal(s.done, false);
  assert.equal(
    s.events.filter((e) => e.event === "content_block_start").length,
    1,
  );
  assert.equal((s.events.at(-1)?.data.content_block as any)?.type, "tool_use");
  active.items[0].status = "failed";
  active.items[0].error = { code: "denied" };
  active.status = "completed";
  s.update(active, "h", "a", "m");
  const count = s.events.length;
  s.update(active, "h", "a", "m");
  assert.equal(s.events.length, count);
  const result: any = s.events.find(
    (e) => (e.data.content_block as any)?.type === "tool_result",
  )?.data.content_block;
  assert.equal(result.is_error, true);
  assert.match(result.content[0].text, /denied/);
  assert.equal(s.events.at(-1)?.event, "message_stop");
});
test("original Chat replays recorded MCP results and preserves tool errors", () => {
  const succeeded = sample[1];
  const failed: Item = {
    ...succeeded,
    id: "failed-tool",
    result: {
      content: [{ type: "text", text: "Connector refused the request" }],
      isError: true,
    },
  };
  const legacy: Item = { ...succeeded, id: "legacy-tool", result: "Legacy tool output" };
  const saved = turn([succeeded, failed, legacy]);
  const conversation: Conversation = {
    id: "mcp-history",
    title: "MCP history",
    mode: "chat",
    model: "model",
    providerId: "provider",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [saved],
  };
  const update = inAdapterScope(newAdapterScope("mcp-owner"), () =>
    conversationUpdate(conversation, false),
  );
  assert.deepEqual(
    update.contentBlocks?.filter((block) => block.toolDisplayName).map((block) => [block.text, block.state]),
    [["actual result", 2], ["Connector refused the request", 3], ["Legacy tool output", 2]],
  );
  const results = completionBlocks(saved).filter((block) => block.start.type === "tool_result");
  assert.deepEqual(results.map((block) => block.start.is_error), [false, true, false]);
});
test("rich history reload preserves the same observed tool call/result and reasoning", () => {
  const c = {
    id: "c",
    createdAt: 1,
    updatedAt: 1,
    turns: [turn(sample)],
  } as Conversation;
  const restored = conversationRestMessages(c).messages.find(
    (m) => m.sender === "assistant",
  );
  assert.deepEqual(
    restored.content.map((b: any) => b.type),
    ["thinking", "tool_use", "tool_result", "text"],
  );
  assert.equal(restored.content[1].id, restored.content[2].tool_use_id);
  assert.equal(restored.content[3].text, "Recorded reply");
});
test("legitimate recorded web/command results preserve failure and bounded metadata", () => {
  const b = completionBlocks(
    turn([
      {
        id: "search",
        type: "webSearch",
        query: "query",
        sources: [{ url: "https://example.test", title: "Title" }],
        status: "completed",
      },
      {
        id: "command",
        type: "commandExecution",
        command: "false",
        aggregatedOutput: "failure",
        exitCode: 1,
        status: "completed",
      },
    ]),
  );
  assert.match(JSON.stringify(b[1]), /https:\/\/example.test/);
  assert.equal(b[3].start.is_error, true);
  assert.equal(b[0].start.approval_key, undefined);
});
test("Hub Chat sends shell commands as commands with their original quoting", () => {
  const commands = [
    `/bin/bash -lc "sed -n '1,240p' /fixtures/api-image/SKILL.md"`,
    `cat '/fixtures/quoted.md”'`,
    String.raw`Get-Content -LiteralPath 'C:\fixtures\with spaces\SKILL.md'`,
  ];
  const conversation: Conversation = {
    id: "shell-history",
    title: "Shell history",
    mode: "chat",
    model: "model",
    providerId: "provider",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      turn(
        commands.map((command, index) => ({
          id: `command-${index}`,
          type: "commandExecution",
          command,
          lifecycleStatus: "completed",
        })),
      ),
    ],
  };
  const update = inAdapterScope(newAdapterScope("shell-owner"), () =>
    conversationUpdate(conversation, false),
  );
  assert.deepEqual(
    update.contentBlocks
      ?.filter((block) => block.toolDisplayName === "Bash")
      .map(({ rowKind, inputSummaryKind, inputSummary }) => [
        rowKind,
        inputSummaryKind,
        inputSummary,
      ]),
    commands.map((command) => [2, 2, command]),
  );
});
test("unknown, changing, malformed, oversized and unfinished recorded content is not reported successful", () => {
  for (const items of [
    [{ id: "x", type: "unknown" }],
    [
      {
        id: "x",
        type: "mcpToolCall",
        tool: "x",
        input: {},
        status: "completed",
      },
    ],
    [
      {
        id: "x",
        type: "mcpToolCall",
        tool: "x",
        input: {},
        status: "inProgress",
      },
    ],
    [
      {
        id: "x",
        type: "mcpToolCall",
        tool: "x",
        input: {},
        result: "a".repeat(150000),
        status: "completed",
      },
    ],
  ])
    assert.equal(stream(turn(items)).events.at(-1)?.event, "error");
  const s = new RestCompletionTextStream();
  const t = turn(sample.slice(0, 2), "inProgress");
  s.update(t, "h", "a", "m");
  t.items[1].result = "replaced";
  s.update(t, "h", "a", "m");
  assert.equal(s.events.at(-1)?.event, "error");
});
test("recorded limit stop reasons remain protocol stop reasons rather than generic failure", () => {
  for (const reason of [
    "length",
    "tool_use_limit",
    "conversation_length_limit",
    "usage_limit",
  ] as const) {
    const t = turn(sample);
    t.stopReason = reason;
    const s = stream(t);
    assert.equal(s.events.at(-1)?.event, "message_stop");
    assert.equal(
      (s.events.find((e) => e.event === "message_delta")?.data.delta as any)
        .stop_reason,
      reason === "length" ? "max_tokens" : reason,
    );
  }
});

test("search text waits for its own stable citations, preserves Unicode spans and reloads identically", () => {
  const s = new RestCompletionTextStream({ deferTextForCitations: true });
  const t = turn(
    [{ id: "reply", type: "agentMessage", text: "😀 cited" }],
    "inProgress",
  );
  s.update(t, "h", "a", "m");
  assert.equal(
    s.events.filter((e) => e.event === "content_block_start").length,
    0,
  );
  t.items[0].citations = [
    { url: "https://example.test/page", title: "Page", start: 3, end: 8 },
  ];
  t.items[0].lifecycleStatus = "completed";
  s.update(t, "h", "a", "m");
  const block: any = reduce(s)[0];
  assert.equal(block.text, "😀 cited");
  assert.equal(block.citations[0].start_index, 2);
  assert.equal(block.citations[0].end_index, 7);
  assert.equal(block.citations[0].metadata.type, "webpage_metadata");
  assert.equal(s.done, false); // This item's completion does not end the turn.
  t.status = "completed";
  s.update(t, "h", "a", "m");
  assert.equal(s.events.at(-1)?.event, "message_stop");
  const history = conversationRestMessages({
    id: "c",
    turns: [t],
    createdAt: 1,
    updatedAt: 1,
  } as Conversation);
  assert.equal(history.messages[1].content[0].text, block.text);
  assert.deepEqual(history.messages[1].content[0].citations, block.citations);
});

test("Chat removes web citation markers and preserves recorded sources and Markdown code", () => {
  const marker = "\uE200cite\uE202turn3search7\uE202turn4search1\uE202turn0search0\uE202turn7view0\uE201";
  const resolved = "\uE200cite\uE202turn9search0\uE201";
  const code = `\`${marker}\`\n\n~~~text\n${resolved}\n~~~\n\nturn9search0`;
  const text = `😀 fact${marker}. Proof${resolved}.\n\n${code}`;
  const expected = `😀 fact. Proof.\n\n${code}`;
  const url = "https://example.test/proof";
  const citedStart = text.indexOf("Proof");
  const reply: Item = {
    id: "reply",
    type: "agentMessage",
    text,
    citations: [
      { url, start: citedStart, end: citedStart + "Proof".length },
      { url: "https://example.test/citation", start: text.indexOf(resolved), end: text.indexOf(resolved) + resolved.length },
    ],
  };
  const t = turn([
    { id: "search", type: "webSearch", query: "proof", status: "completed", sources: [{ url }] },
    reply,
  ]);
  const conversation: Conversation = {
    id: "openai-citations",
    title: "Web citations",
    mode: "chat",
    model: "model",
    providerId: "provider",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [t],
  };
  const update = inAdapterScope(newAdapterScope("citation-owner"), () =>
    conversationUpdate(conversation, false),
  );
  const timeline = update.contentBlocks?.find((block) => block.id.endsWith(":reply"));
  assert.equal(timeline?.text, expected);
  assert.deepEqual(timeline?.citations?.map((citation: any) => [citation.url, citation.startIndex, citation.endIndex]), [
    [url, 8, 13],
    ["https://example.test/citation", 13, 13],
  ]);
  assert.ok(update.contentBlocks?.some((block) => block.displayContent?.content.value.items?.some((source: any) => source.url === url)));
  const history = conversationRestMessages(conversation).messages[1].content.at(-1);
  assert.equal(history.text, expected);
  assert.deepEqual(history.citations.map((citation: any) => [citation.url, citation.start_index, citation.end_index]), [
    [url, 8, 13],
    ["https://example.test/citation", 13, 13],
  ]);
  assert.equal(reply.text, text);
});

test("Chat streams text across partial OpenAI citations without emitting protocol characters", () => {
  const marker = "\uE200cite\uE202turn3search7\uE202turn4search1\uE201";
  const s = new RestCompletionTextStream();
  const reply: Item = { id: "reply", type: "agentMessage", text: "Start" };
  const t = turn([reply], "inProgress");
  for (let i = 0; i <= marker.length; i++) {
    reply.text = `Start${marker.slice(0, i)}`;
    s.update(t, "h", "a", "m");
    assert.equal(reduce(s)[0].text, "Start");
  }
  reply.text = `Start${marker} ordinary prose`;
  s.update(t, "h", "a", "m");
  assert.equal(reduce(s)[0].text, "Start ordinary prose");
  for (const ending of [" `", ` \`${marker} in code`, ` \`${marker} in code\``]) {
    reply.text = `Start${marker} ordinary prose${ending}`;
    s.update(t, "h", "a", "m");
  }
  t.status = "completed";
  s.update(t, "h", "a", "m");
  assert.equal(s.events.at(-1)?.event, "message_stop");
  assert.equal(reduce(s)[0].text, `Start ordinary prose \`${marker} in code\``);
});

test("citation URLs and surrogate split offsets fail closed, ordinary text stays incremental", () => {
  for (const citation of [
    { url: "javascript:alert(1)", start: 0, end: 2 },
    { url: "https://example.test", start: 1, end: 2 },
  ]) {
    assert.equal(
      stream(
        turn([
          { id: "t", type: "agentMessage", text: "😀", citations: [citation] },
        ]),
      ).events.at(-1)?.event,
      "error",
    );
  }
  const s = stream(
    turn([{ id: "t", type: "agentMessage", text: "first" }], "inProgress"),
  );
  assert.ok(s.events.some((e) => (e.data.delta as any)?.text === "first"));
  assert.equal(s.done, false);
});

test("large stable cited text uses bounded chunks, advances every batch and survives the actual reducer", () => {
  const text = "x".repeat(300 * 1024);
  const s = new RestCompletionTextStream({ deferTextForCitations: true });
  s.update(
    turn([
      {
        id: "large",
        type: "agentMessage",
        text,
        citations: [{ url: "https://example.test", start: 0, end: 5 }],
      },
    ]),
    "h",
    "a",
    "m",
  );
  assert.equal(s.events.at(-1)?.event, "message_stop");
  let cursor = 0;
  while (cursor < s.events.length) {
    const batch = s.batch(cursor);
    assert.ok(batch.cursor > cursor);
    cursor = batch.cursor;
  }
  const restored = reduce(s)[0];
  assert.equal(restored.text, text);
  assert.equal(restored.citations[0].end_index, 5);
  assert.equal(restored.citations[0].metadata.type, "webpage_metadata");
});

test("growing engine reasoning summaries wait for stability while thinking remains incremental", () => {
  const s = new RestCompletionTextStream();
  const t = turn(
    [
      {
        id: "thought",
        type: "reasoning",
        text: "Thinking",
        summary: ["One"],
        lifecycleStatus: "inProgress",
      },
    ],
    "inProgress",
  );
  s.update(t, "h", "a", "m");
  t.items[0].summary![0] += " more";
  t.items[0].text += " further";
  s.update(t, "h", "a", "m");
  assert.equal(s.done, false);
  assert.equal(
    s.events.filter(
      (e) => (e.data.delta as any)?.type === "thinking_summary_delta",
    ).length,
    0,
  );
  assert.equal(reduce(s)[0].thinking, "Thinking further");
  t.items[0].summary!.push("Second");
  t.items[0].lifecycleStatus = "completed";
  s.update(t, "h", "a", "m");
  assert.deepEqual(JSON.parse(JSON.stringify(reduce(s)[0].summaries)), [
    { summary: "One more" },
    { summary: "Second" },
  ]);
  t.status = "completed";
  s.update(t, "h", "a", "m");
  const history = conversationRestMessages({
    id: "c",
    createdAt: 1,
    updatedAt: 1,
    turns: [t],
  } as Conversation);
  assert.deepEqual(
    history.messages[1].content[0].summaries,
    JSON.parse(JSON.stringify(reduce(s)[0].summaries)),
  );
});
test("attachment history uses the original scoped file registry and pinned file consumer", () => {
  inAdapterScope(newAdapterScope("owner"), () => {
    const t = turn(sample);
    t.attachments = [
      {
        id: "file-id",
        name: "note.txt",
        size: 4,
        kind: "file",
        path: "/untrusted/never-read",
      },
    ] as any;
    const c = {
      id: "c",
      createdAt: 1,
      updatedAt: 1,
      turns: [t],
    } as Conversation;
    assert.throws(() => conversationRestMessages(c), /organization/);
    const h = conversationRestMessages(c, "org");
    const source = fs.readFileSync(
      ".restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1/shared-m-w-0-Dp3k4Hda.js",
      "utf8",
    );
    const ast = ts.createSourceFile(
      "file.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const defs = ["BB", "dT"].map((name) =>
      ast.statements
        .find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name)
        ?.getText(ast),
    );
    assert.ok(defs.every(Boolean));
    const files = vm.runInNewContext(`${defs.join("; \n")}; dT(message)`, {
      message: h.messages[0],
      EX: [],
    });
    assert.equal(files[0].file_name, "note.txt");
    assert.equal(files[0].serverFileUuid, "file-id");
    assert.equal(knownFile("file-id")?.path, undefined);
    assert.deepEqual(h.messages[1].files_v2, []);
    assert.equal(h.messages[1].stop_reason, "end_turn");
    const changed = structuredClone(t);
    changed.attachments[0].size = 5;
    c.savedBranches = [{ id: "other", turns: [changed] }] as any;
    assert.throws(() => conversationRestMessages(c, "org"), /identity changed/);
  });
});
test("failed and interrupted saved turns reopen with original official stop state, not successful completion", () => {
  for (const status of ["failed", "interrupted"] as const) {
    const t = turn(sample, status);
    t.error = "original stored error";
    const h = conversationRestMessages({
      id: "c",
      createdAt: 1,
      updatedAt: 1,
      turns: [t],
    } as Conversation);
    assert.equal(
      h.messages[1].stop_reason,
      status === "failed" ? "error" : "user_canceled",
    );
    assert.equal(t.error, "original stored error");
    assert.equal(h.messages[1].content.at(-1).text, "Recorded reply");
  }
});

test("normal text then running tool then cited reply preserves ordered messages across snapshots", () => {
  const s = new RestCompletionTextStream();
  const t = turn(
    [
      {
        id: "intro",
        type: "agentMessage",
        text: "Checking",
        lifecycleStatus: "inProgress",
      },
    ],
    "inProgress",
  );
  s.update(t, "h", "a", "m");
  assert.equal(reduce(s)[0].text, "Checking");
  t.items[0].text += " now.";
  t.items[0].lifecycleStatus = "completed";
  t.items.push({
    id: "lookup",
    type: "dynamicToolCall",
    tool: "docs.search",
    arguments: { query: "test" },
    lifecycleStatus: "inProgress",
  });
  s.update(t, "h", "a", "m");
  assert.equal(s.done, false);
  assert.deepEqual(
    reduce(s).map((b) => b.type),
    ["text", "tool_use"],
  );
  t.items[1].lifecycleStatus = "completed";
  t.items[1].result = { text: "source result" };
  t.items.push({
    id: "answer",
    type: "agentMessage",
    text: "Cited answer",
    lifecycleStatus: "inProgress",
  });
  s.update(t, "h", "a", "m");
  assert.equal(s.done, false);
  assert.deepEqual(
    reduce(s).map((b) => b.type),
    ["text", "tool_use", "tool_result"],
  );
  t.items[2].citations = [
    { url: "https://example.test/source", start: 0, end: 5 },
  ];
  t.items[2].lifecycleStatus = "completed";
  s.update(t, "h", "a", "m");
  assert.equal(s.done, false);
  t.status = "completed";
  s.update(t, "h", "a", "m");
  const blocks = reduce(s);
  assert.equal(s.events.at(-1)?.event, "message_stop");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["text", "tool_use", "tool_result", "text"],
  );
  assert.equal(blocks[0].text, "Checking now.");
  assert.deepEqual(JSON.parse(blocks[1].buffered_input), { query: "test" });
  assert.equal(blocks[3].text, "Cited answer");
  assert.equal(blocks[3].citations[0].url, "https://example.test/source");
  const history = conversationRestMessages({
    id: "c",
    createdAt: 1,
    updatedAt: 1,
    turns: [t],
  } as Conversation).messages[1].content;
  assert.deepEqual(
    history.map((b: any) => b.type),
    blocks.map((b) => b.type),
  );
  assert.equal(history[0].text, blocks[0].text);
  assert.deepEqual(history[3].citations, blocks[3].citations);
});

test("a protected MCP call publishes the original auth event and retains it in reopened Chat", async () => {
  const pending = new RestCompletionTextStream();
  const started = { ...protectedToolFailure, error: null, lifecycleStatus: "inProgress" as const };
  const initial = turn([{ ...started, status: "inProgress" }], "inProgress");
  const finished = turn([protectedToolFailure, { id: "answer", type: "agentMessage", text: "Finished" }]);
  pending.update(initial, "human", "assistant", "model");
  const first = pending.batch(0);
  pending.update(finished, "human", "assistant", "model");
  const answer = (result: ReturnType<typeof pending.batch>) => ({
    status: 200,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({ operation_id: "22222222-2222-4222-8222-222222222222", ...result })),
  });
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const org = "33333333-3333-4333-8333-333333333333";
  const response = await openOfficialCompletion(
    { method: "POST", path: `/api/organizations/${org}/chat_conversations/${conversationId}/completion` },
    new AbortController().signal,
    async () => answer(pending.batch(first.cursor)),
    async () => answer(first),
    () => () => {},
    { pollMs: 1, deadlineMs: 1_000 },
  );
  const events = await response.text();
  const auth = {
    server_id: "c5a65e76-ef46-4cea-8375-c9523985f990",
    tool_use_id: "turn:protected-call",
    error_code: "mcp_auth_required",
  };
  assert.deepEqual(JSON.parse(events.match(/^event: mcp_auth_required\ndata: (.+)$/m)?.[1] ?? "null"), {
    type: "mcp_auth_required",
    ...auth,
  });
  assert.match(events, /event: message_stop/);
  const conversation: Conversation = {
    id: conversationId, title: "", mode: "chat", providerId: "test",
    model: "model", createdAt: 1, updatedAt: 1, pinned: false, archived: false,
    turns: [finished],
  };
  const assistant = conversationRestMessages(conversation, org).messages.find(row => row.sender === "assistant");
  assert.deepEqual(assistant.content[0].mcp_auth_required, { ...auth, conversation_uuid: conversationId });
  assert.equal(assistant.content[1].is_error, true);
  assert.match(assistant.content[1].content[0].text, /Auth required/);
  const reportedError = stream(turn([{ ...protectedToolFailure, result: { isError: true }, error: { message: "Auth required" } }]));
  assert.equal(reportedError.events.some(entry => entry.event === "mcp_auth_required"), false);
});
