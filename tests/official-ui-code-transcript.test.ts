import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertCodeTranscript,
  hydrateCodeOutput,
  pageCodeTranscript,
} from "../electron/official-ui/native/code-transcript";
import type { Conversation, Item } from "../shared/types";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation",
    title: "Test",
    mode: "code",
    providerId: "provider",
    model: "model",
    pinned: false,
    archived: false,
    createdAt: 1000,
    updatedAt: 1000,
    turns: [
      {
        id: "turn",
        prompt: "Question",
        attachments: [],
        status: "completed",
        createdAt: 1000,
        items: [{ id: "reply", type: "agentMessage", text: "Answer" }],
      },
    ],
    ...overrides,
  };
}

test("Code text transcript keeps order, identity and parent links", () => {
  const result = convertCodeTranscript(conversation());
  assert.deepEqual(result.unsupported, []);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].message.content, "Question");
  assert.deepEqual(result.rows[1].message.content, [
    { type: "text", text: "Answer" },
  ]);
  assert.equal(result.rows[1].parentUuid, result.rows[0].uuid);
  assert.equal(result.rows[1].timestamp, "1970-01-01T00:00:01.000Z");
});

test("Code history keeps a steered message's accepted ID, image and file reference", () => {
  const c = conversation();
  c.turns[0].items.unshift(
    {
      id: "steer",
      type: "userMessage",
      steered: true,
      clientId: "client-steer",
      officialCodeEventId: "405b74bf-73ef-451d-a761-b0179a792fb7",
      text: "Use these files",
      attachments: [
        {
          id: "image",
          name: "diagram.png",
          kind: "image",
          path: "/work/diagram.png",
          size: 2,
        },
        {
          id: "file",
          name: "notes.txt",
          kind: "text",
          path: "/work/notes.txt",
          size: 4,
        },
      ],
    },
    {
      id: "old-steer",
      type: "userMessage",
      steered: true,
      clientId: "old-client",
      text: "Text only",
    },
  );
  const { rows, unsupported } = convertCodeTranscript(c, (attachment) =>
    attachment.id === "image" ? { mime: "image/png", base64: "AAA=" } : null,
  );

  assert.deepEqual(unsupported, []);
  assert.deepEqual(rows[1], {
    type: "user",
    uuid: "405b74bf-73ef-451d-a761-b0179a792fb7",
    parentUuid: rows[0].uuid,
    sessionId: c.id,
    timestamp: rows[0].timestamp,
    isSidechain: false,
    message: {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAA=" },
        },
        { type: "text", text: "Use these files" },
      ],
    },
    file_attachments: [
      { file_uuid: "file", file_name: "notes.txt", is_image: false },
    ],
  });
  assert.equal(rows[2].uuid, "old-client");
  assert.equal(rows[2].parentUuid, rows[1].uuid);
  assert.equal(rows[2].message.content, "Text only");
  assert.equal(rows[2].file_attachments, undefined);
  assert.equal(rows[3].parentUuid, rows[2].uuid);
});

test("unsupported tool records and attachments are reported, never declared complete", () => {
  const c = conversation();
  c.turns[0].items.push({ id: "change", type: "fileChange" });
  c.turns[0].attachments = [{ id: "attachment" } as never];
  assert.deepEqual(convertCodeTranscript(c).unsupported, [
    "attachments",
    "fileChange",
  ]);
  assert.throws(
    () => convertCodeTranscript(conversation({ mode: "chat" })),
    /Code conversation/,
  );
});

test("Code history displays the saved review output in order", () => {
  const c = conversation();
  c.turns[0].prompt = "/review";
  const review =
    "Potential issue.\n\nReview comment:\n- [P1] Keep retries safe — /work/app.ts:12\n  This operation can run twice.";
  c.turns[0].items.unshift(
    {
      id: "review-start",
      type: "enteredReviewMode",
      review: "uncommitted changes",
    },
    { id: "review-end", type: "exitedReviewMode", review },
  );

  const result = convertCodeTranscript(c);
  const row = result.rows.find((entry) => entry.uuid === "turn:item:review-end");
  assert.equal(row?.type, "assistant");
  assert.deepEqual(row?.message.content, [{ type: "text", text: review }]);
  assert.equal(result.rows.at(-1)?.parentUuid, row?.uuid);
});

test("Code history retains a subagent report as a peer message", () => {
  const c = conversation();
  const from = "405b74bf-73ef-451d-a761-b0179a792fb7";
  c.turns[0].items.unshift({
    id: "peer",
    type: "peerMessage",
    text: "Found the failing request.",
    agentThreadId: from,
    origin: { kind: "peer", subagent: true, handback: true },
  });

  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(rows[1], {
    type: "user",
    uuid: "turn:item:peer",
    parentUuid: rows[0].uuid,
    sessionId: c.id,
    timestamp: rows[0].timestamp,
    isSidechain: false,
    message: { role: "user", content: "Found the failing request." },
    origin: {
      kind: "peer",
      name: undefined,
      from,
      senderTaskId: from,
      subagent: true,
      handback: true,
    },
  });
  assert.equal(rows[2].parentUuid, rows[1].uuid);
});

test("Code history preserves the original agents-stopped notice", () => {
  const c = conversation();
  c.turns[0].items.push({
    id: "agents-stopped", type: "agentNotice", notice: "agents_killed",
  });

  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  assert.equal(rows[2].type, "system");
  assert.equal(rows[2].subtype, "agents_killed");
  assert.equal(rows[2].uuid, "turn:item:agents-stopped");
  assert.equal(rows[2].parentUuid, rows[1].uuid);
  assert.deepEqual(rows[2].message.content, []);
});

test("Code history preserves the observed sleep duration in the generic tool result", () => {
  const c = conversation();
  c.turns[0].items.unshift({
    id: "sleep",
    type: "sleep",
    lifecycleStatus: "completed",
    durationMs: 1_250,
  });

  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(rows[1].message.content, [{
    type: "tool_use", id: "turn:activity:sleep:0", name: "Sleep", input: {},
  }]);
  assert.deepEqual(rows[2].message.content, [{
    type: "tool_result", tool_use_id: "turn:activity:sleep:0",
    content: '{"durationMs":1250}', is_error: false,
  }]);
});

test("completed commands retain their tool call, result and failure state", () => {
  const c = conversation();
  c.turns[0].items = [
    {
      id: "cmd",
      type: "commandExecution",
      command: "pwd",
      aggregatedOutput: "/work",
      lifecycleStatus: "failed",
    },
  ];
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(rows[1].message.content, [
    {
      type: "tool_use",
      id: "turn:tool:cmd",
      name: "Bash",
      input: { command: "pwd" },
    },
  ]);
  assert.deepEqual(rows[2].message.content, [
    {
      type: "tool_result",
      tool_use_id: "turn:tool:cmd",
      content: "/work",
      is_error: true,
    },
  ]);
  assert.equal(rows[2].parentUuid, rows[1].uuid);
});

test("running commands are not presented as completed", () => {
  const c = conversation();
  c.turns[0].items = [
    {
      id: "cmd",
      type: "commandExecution",
      command: "pwd",
      lifecycleStatus: "inProgress",
    },
  ];
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, ["running-command"]);
  assert.equal(rows.length, 2);
});

test("visible reasoning summaries keep their original sections without fabricating a signature", () => {
  const c = conversation();
  c.turns[0].items = [
    { id: "thinking", type: "reasoning", summary: ["First", "Second"] },
  ];
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(rows[1].message.content, [
    { type: "thinking", thinking: "First\n\nSecond" },
  ]);
  assert.deepEqual(rows[1].claudexReasoning, ["First", "Second"]);
  assert.equal("signature" in (rows[1].message.content as any[])[0], false);
});

test("a declined command is not reported as successful when its lifecycle is complete", () => {
  const c = conversation();
  c.turns[0].items = [
    {
      id: "cmd",
      type: "commandExecution",
      command: "pwd",
      status: "declined",
      lifecycleStatus: "completed",
    },
  ];
  const result = convertCodeTranscript(c);
  assert.deepEqual(result.unsupported, []);
  assert.equal((result.rows[2].message.content as any[])[0].is_error, true);
});

test("failed and interrupted Code turns retain their outcome without blocking the history", () => {
  const c = conversation();
  c.turns[0].status = "failed";
  c.turns[0].error = "CODE_TEST_FAILURE";
  const failed = convertCodeTranscript(c);
  assert.deepEqual(failed.unsupported, []);
  assert.equal(failed.rows.at(-1)?.isApiErrorMessage, true);
  assert.deepEqual(failed.rows.at(-1)?.message.content, [
    { type: "text", text: "CODE_TEST_FAILURE" },
  ]);
  c.turns[0].status = "interrupted";
  assert.deepEqual(convertCodeTranscript(c).unsupported, []);
  assert.deepEqual(convertCodeTranscript(c).rows.at(-1)?.message.content, [
    { type: "text", text: "CODE_TEST_FAILURE" },
  ]);
  c.turns[0].error = undefined;
  c.turns[0].stopReason = "restart";
  const restarted = convertCodeTranscript(c);
  assert.deepEqual(restarted.unsupported, []);
  assert.equal(restarted.rows.at(-1)?.isApiErrorMessage, true);
  assert.deepEqual(restarted.rows.at(-1)?.message.content, [
    { type: "text", text: "The app closed before this response finished." },
  ]);
  c.turns[0].status = "completed";
  c.turns[0].error = undefined;
  c.turns[0].stopReason = "length";
  assert.ok(convertCodeTranscript(c).unsupported.includes("turn-stop-reason"));
});

test("a user-stopped Code turn uses the original interruption markers instead of an API error", () => {
  const c = conversation();
  const turn = c.turns[0];
  turn.status = "interrupted";
  turn.userStopped = true;
  turn.error = undefined;
  turn.items = [{ type: "commandExecution", id: "cmd", command: "sleep 30", lifecycleStatus: "interrupted", aggregatedOutput: "" }];
  const result = convertCodeTranscript(c);
  assert.ok(!result.rows.some((row) => row.isApiErrorMessage));
  assert.deepEqual(result.rows.at(-1)?.message.content, [{ type: "text", text: "[Request interrupted by user]" }]);
  const tool = result.rows.flatMap((row) => Array.isArray(row.message.content) ? row.message.content : []).find((part: any) => part.type === "tool_result") as any;
  assert.equal(tool.content, "Tool execution stopped by user");
  turn.items[0].aggregatedOutput = "partial output";
  const partial = convertCodeTranscript(c);
  const saved = partial.rows.flatMap((row) => Array.isArray(row.message.content) ? row.message.content : []).find((part: any) => part.type === "tool_result") as any;
  assert.equal(saved.content, "partial output");
  turn.error = "real engine failure";
  assert.equal(convertCodeTranscript(c).rows.at(-1)?.isApiErrorMessage, true);
  turn.error = undefined;
  turn.stopReason = "restart";
  assert.equal(convertCodeTranscript(c).rows.at(-1)?.isApiErrorMessage, true);
});

test("MCP and dynamic tool calls survive transcript conversion with bounded results", () => {
  const c = conversation();
  c.turns[0].items = [
    {
      id: "mcp-1",
      type: "mcpToolCall",
      tool: "docs.search",
      input: { query: "bike" },
      result: { content: [{ type: "text", text: "found" }] },
      success: true,
      status: "completed",
    },
    {
      id: "dynamic-1",
      type: "dynamicToolCall",
      tool: "browser.read",
      arguments: { url: "https://example.test" },
      result: {
        title: "Page",
        image: `data:image/png;base64,${"a".repeat(120_000)}`,
      },
      lifecycleStatus: "completed",
    },
  ] as any;
  const converted = convertCodeTranscript(c);
  assert.deepEqual(converted.unsupported, []);
  const uses = converted.rows
    .filter((row) => row.type === "assistant")
    .flatMap((row) =>
      Array.isArray(row.message.content)
        ? row.message.content.filter((block) => block.type === "tool_use")
        : [],
    );
  const results = converted.rows
    .filter((row) => row.type === "user")
    .flatMap((row) =>
      Array.isArray(row.message.content)
        ? row.message.content.filter((block) => block.type === "tool_result")
        : [],
    );
  assert.equal(uses.length, 2);
  assert.equal(uses[0].name, "docs.search");
  assert.equal((uses[0] as any).input.query, "bike");
  assert.equal(results.length, 2);
  assert.equal(results[0].is_error, false);
  assert.deepEqual(results[0].content, [{ type: "text", text: "found" }]);
  assert.deepEqual(results[1].content, [
    { type: "text", text: '{\n  "title": "Page"\n}' },
  ]);
});

test("an in-progress MCP tool is represented without making the whole transcript unsupported", () => {
  const c = conversation();
  c.turns[0].status = "inProgress";
  c.turns[0].items = [
    {
      id: "mcp-run",
      type: "mcpToolCall",
      tool: "browser.open",
      input: { url: "https://example.test" },
      progress: "Opening",
      lifecycleStatus: "inProgress",
    },
  ] as any;
  const converted = convertCodeTranscript(c);
  assert.deepEqual(converted.unsupported, [
    "running-tool-call",
    "running-turn",
  ]);
  assert.ok(
    converted.rows.some((row) =>
      JSON.stringify(row).includes('"name":"browser.open"'),
    ),
  );
});

test("a created text file retains its exact content and official patch metadata", () => {
  const c = conversation();
  c.turns[0].items = [
    {
      id: "file",
      type: "fileChange",
      status: "completed",
      changes: [
        {
          path: "/work/example.txt",
          kind: { type: "add" },
          diff: "first\nsecond",
        },
      ],
      generatedFiles: [
        {
          id: "artifact",
          name: "example.txt",
          path: "/work/example.txt",
          language: "text",
          operation: "create",
          state: "ready",
          content: "first\nsecond",
        },
      ],
    },
  ];
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(rows[1].message.content, [
    {
      type: "tool_use",
      id: "turn:file:file:0",
      name: "Write",
      input: { file_path: "/work/example.txt", content: "first\nsecond" },
    },
  ]);
  assert.deepEqual(rows[2].toolUseResult?.structuredPatch[0].lines, [
    "+first",
    "+second",
    "\\ No newline at end of file",
  ]);
  assert.equal(
    rows[2].toolUseResult && "content" in rows[2].toolUseResult
      ? rows[2].toolUseResult.content
      : undefined,
    "first\nsecond",
  );
  assert.equal(rows[2].toolUseResult?.claudexGeneratedFiles, undefined);
});

test("a pending, failed or declined text creation keeps its Write identity without a create result", () => {
  const c = conversation();
  c.turns[0].status = "inProgress";
  const item: Item = {
    id: "file",
    type: "fileChange",
    status: "inProgress",
    changes: [{ path: "/work/new.txt", kind: { type: "add" }, diff: "hello\n" }],
  };
  c.turns[0].items = [item];
  const pending = convertCodeTranscript(c);
  assert.deepEqual(pending.unsupported, ["running-turn"]);
  assert.equal(pending.rows.length, 2);
  const write = {
    type: "tool_use", id: "turn:file:file:0", name: "Write",
    input: { file_path: "/work/new.txt", content: "hello\n" },
  };
  assert.deepEqual(pending.rows[1].message.content, [write]);
  for (const status of ["failed", "declined", "interrupted"]) {
    item.status = status;
    c.turns[0].status = status === "interrupted" ? "interrupted" : "completed";
    const { rows, unsupported } = convertCodeTranscript(c);
    assert.deepEqual(unsupported, []);
    assert.deepEqual(rows[1].message.content, [write]);
    assert.deepEqual(rows[2].message.content, [{
      type: "tool_result", tool_use_id: write.id, content: "", is_error: true,
    }]);
    assert.equal(rows[2].toolUseResult, undefined);
  }
});

test("one completed patch renders created and edited files in their original order", () => {
  const c = conversation();
  const edit = {
    path: "/work/edited.txt",
    kind: { type: "update" },
    diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
  };
  c.turns[0].items = [
    {
      id: "mixed-patch",
      type: "fileChange",
      status: "completed",
      changes: [
        edit,
        { path: "/work/created.txt", kind: { type: "add" }, diff: "created\n" },
      ],
      generatedFiles: [
        {
          id: "created",
          name: "created.txt",
          path: "/work/created.txt",
          language: "text",
          operation: "create",
          state: "ready",
        },
      ],
    },
  ];
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(
    rows.map((row) => [row.uuid, row.parentUuid]),
    [
      ["turn:user", null],
      ["turn:file:mixed-patch:0:use", "turn:user"],
      ["turn:file:mixed-patch:0:result", "turn:file:mixed-patch:0:use"],
      ["turn:file:mixed-patch:1:use", "turn:file:mixed-patch:0:result"],
      ["turn:file:mixed-patch:1:result", "turn:file:mixed-patch:1:use"],
    ],
  );
  assert.match(JSON.stringify(rows[1].message.content), /"name":"Edit"/);
  assert.match(JSON.stringify(rows[3].message.content), /"name":"Write"/);
  assert.equal(rows[4].toolUseResult?.content, "created\n");

  edit.diff += "\\ No newline at end of file\n";
  const withoutFinalNewline = convertCodeTranscript(c);
  assert.deepEqual(withoutFinalNewline.unsupported, []);
  assert.equal(withoutFinalNewline.rows[2].toolUseResult?.newString, "new");
  assert.equal(withoutFinalNewline.rows[4].toolUseResult?.content, "created\n");
});

test("a single-hunk file edit preserves the original diff and reconstructed display fields", () => {
  const c = conversation();
  const diff = "@@ -1,2 +1,2 @@\n-old\n+new\n context\n";
  c.turns[0].items = [
    {
      id: "file",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "/work/example.txt", kind: { type: "update" }, diff }],
    },
  ];
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(rows[1].message.content, [
    {
      type: "tool_use",
      id: "turn:file:file:0",
      name: "Edit",
      input: {
        file_path: "/work/example.txt",
        old_string: "old\ncontext\n",
        new_string: "new\ncontext\n",
        replace_all: false,
      },
    },
  ]);
  assert.equal(
    rows[2].toolUseResult && "claudexOriginalDiff" in rows[2].toolUseResult
      ? rows[2].toolUseResult.claudexOriginalDiff
      : undefined,
    diff,
  );
  assert.deepEqual(rows[2].toolUseResult?.structuredPatch[0].lines, [
    "-old",
    "+new",
    " context",
  ]);
});

test("text edits preserve CRLF, missing final newlines, and literal patch text", () => {
  const c = conversation();
  const crlf = "@@ -1,2 +1,2 @@\n-start\r\n-before\r\n+start\n+after\n";
  const eof = "@@ -2 +2 @@\n-before\n\\ No newline at end of file\n+after\n";
  const literal = "@@ -1 +1 @@\n-old\n+\\ No newline at end of file\n";
  c.turns[0].items = [{
    id: "file",
    type: "fileChange",
    status: "completed",
    changes: [
      { path: "/work/crlf.txt", kind: { type: "update" }, diff: crlf },
      { path: "/work/eof.txt", kind: { type: "update" }, diff: eof },
      { path: "/work/literal.txt", kind: { type: "update" }, diff: literal },
      { path: "/work/patch.txt", kind: { type: "add" }, diff: literal },
    ],
  }];
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  const [crlfResult, eofResult, literalResult, created] = rows.flatMap(
    (row) => row.toolUseResult ? [row.toolUseResult] : [],
  );
  assert.deepEqual(crlfResult, {
    filePath: "/work/crlf.txt", originalFile: null, replaceAll: false,
    oldString: "start\r\nbefore\r\n", newString: "start\nafter\n",
    structuredPatch: [{
      oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
      lines: ["-start", "-before", "+start", "+after"],
    }],
    claudexReconstructedFromPatch: true, claudexOriginalDiff: crlf,
  });
  assert.ok("oldString" in eofResult);
  assert.equal(eofResult.oldString, "before");
  assert.equal(eofResult.newString, "after\n");
  assert.deepEqual(eofResult.structuredPatch[0].lines, [
    "-before", "\\ No newline at end of file", "+after",
  ]);
  assert.ok("newString" in literalResult);
  assert.equal(literalResult.newString, "\\ No newline at end of file\n");
  assert.ok("content" in created);
  assert.equal(created.content, literal);
});

test("a multi-hunk file edit keeps every original hunk in the official MultiEdit format", () => {
  const c = conversation();
  const diff =
    "@@ -1,2 +1,2 @@\n-old-one\n+new-one\n context-one\n@@ -20,2 +20,2 @@\n-old-two\n+new-two\n context-two\n";
  c.turns[0].items = [
    {
      id: "file",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "/work/example.txt", kind: { type: "update" }, diff }],
    },
  ];
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  const tool = (rows[1].message.content as any[])[0];
  assert.equal(tool.name, "MultiEdit");
  assert.equal(tool.input.edits.length, 2);
  assert.equal(tool.input.edits[0].old_string, "old-one\ncontext-one\n");
  assert.equal(tool.input.edits[1].new_string, "new-two\ncontext-two\n");
  const result = rows[2].toolUseResult as any;
  assert.deepEqual(result.edits, tool.input.edits);
  assert.deepEqual(
    result.structuredPatch.map((hunk: any) => hunk.oldStart),
    [1, 20],
  );
  assert.equal(result.claudexOriginalDiff, diff);
});

test("paging returns older rows without overlap and reports missing cursors", () => {
  const c = conversation();
  c.turns[0].items = [
    { id: "one", type: "agentMessage", text: "One" },
    { id: "two", type: "agentMessage", text: "Two" },
    { id: "three", type: "agentMessage", text: "Three" },
  ];
  const rows = convertCodeTranscript(c).rows;
  const latest = pageCodeTranscript(rows, "", 2);
  const older = pageCodeTranscript(rows, latest.messages[0].uuid, 2);
  assert.equal(latest.hasMore, true);
  assert.equal(older.hasMore, false);
  assert.deepEqual([...older.messages, ...latest.messages], rows);
  assert.deepEqual(pageCodeTranscript(rows, "missing", 2), {
    messages: [],
    hasMore: false,
    found: false,
    totalRows: 4,
  });
});

test("plans and web searches preserve every task status and actual source without blocking history", () => {
  const c = conversation();
  c.turns[0].items.unshift(
    {
      id: "plan",
      type: "taskPlan",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Verify", status: "inProgress" },
      ],
    },
    {
      id: "search",
      type: "webSearch",
      query: "docs",
      sources: [{ url: "https://example.test/docs", title: "Docs" }],
      lifecycleStatus: "completed",
    },
    {
      id: "page",
      type: "webSearch",
      action: { type: "openPage", url: "https://example.test/docs" },
      lifecycleStatus: "completed",
    },
  );
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  const uses = rows.flatMap((r) =>
    Array.isArray(r.message.content)
      ? r.message.content.filter((b) => b.type === "tool_use")
      : [],
  ) as any[];
  assert.deepEqual(
    uses.map((b) => b.name),
    ["TodoWrite", "WebSearch", "WebFetch"],
  );
  assert.deepEqual(
    uses[0].input.todos.map((t: any) => [t.content, t.status]),
    [
      ["Inspect", "completed"],
      ["Verify", "in_progress"],
    ],
  );
  const search = rows.find((r) => r.toolUseResult?.query === "docs")!;
  assert.deepEqual(
    search.toolUseResult?.results[0].content,
    c.turns[0].items[1].sources,
  );
  assert.equal(
    rows.find((r) => r.claudexSourceItem?.id === "page")?.claudexSourceItem,
    c.turns[0].items[2],
  );
  assert.ok(
    !JSON.stringify(rows).includes('"code":200'),
    "opening a page does not invent a fetched response",
  );
  for (let i = 1; i < rows.length; i++)
    assert.equal(rows[i].parentUuid, rows[i - 1].uuid);
});

test("recorded metadata and completed compaction do not erase history", () => {
  const c = conversation();
  c.turns[0].rawOriginals = ["actual sent prompt"];
  c.turns[0].items.unshift(
    { id: "compact", type: "contextCompaction", lifecycleStatus: "completed" },
    {
      id: "image",
      type: "imageView",
      path: "/work/image.png",
      lifecycleStatus: "completed",
    },
    {
      id: "workflow",
      type: "collabAgentToolCall",
      tool: "workflow",
      workflowName: "review",
      prompt: "inspect",
      lifecycleStatus: "completed",
    },
  );
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(rows[0].claudexSentPrompts, ["actual sent prompt"]);
  assert.equal(rows[1].subtype, "compact_boundary");
  c.turns[0].compactionRequestId = "original-request";
  assert.equal(convertCodeTranscript(c).rows[1].uuid, "original-request:boundary");
  for (const item of c.turns[0].items.slice(0, 3))
    assert.ok(rows.some((row) => row.claudexSourceItem === item));
  const uses = rows.flatMap((row) =>
    Array.isArray(row.message.content)
      ? row.message.content.filter((b) => b.type === "tool_use")
      : [],
  ) as any[];
  assert.deepEqual(
    uses.map((b) => b.name),
    ["Read", "Workflow"],
  );
  for (let i = 1; i < rows.length; i++)
    assert.equal(rows[i].parentUuid, rows[i - 1].uuid);
});

test("Code history uses original compaction status frames until successful completion", () => {
  for (const status of ["inProgress", "interrupted", "failed"] as const) {
    const c = conversation();
    c.turns[0].compaction = "manual";
    c.turns[0].prompt = "";
    c.turns[0].status = status;
    c.turns[0].items = [
      {
        id: "compact",
        type: "contextCompaction",
        lifecycleStatus: status === "inProgress" ? "completed" : status,
      },
    ];
    const { rows, unsupported } = convertCodeTranscript(c);
    assert.ok(!unsupported.includes("contextCompaction"));
    assert.ok(!rows.some((r) => r.subtype === "compact_boundary"));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.type, "system");
    assert.equal(row.subtype, "status");
    assert.equal(row.uuid, status === "inProgress" ? "turn:item:compact:compacting" : "turn:item:compact:compact-end");
    assert.equal(row.status, status === "inProgress" ? "compacting" : null);
    assert.equal(row.compact_result, status === "failed" ? "failed" : undefined);
    assert.deepEqual(row.message.content, []);
  }
  const settled = conversation();
  settled.turns[0].compaction = "manual";
  settled.turns[0].items = [{
    id: "compact", type: "contextCompaction", lifecycleStatus: "completed",
    compactionTokens: { before: 12008, after: 5502 },
  }];
  const [boundary] = convertCodeTranscript(settled).rows;
  assert.equal(boundary.uuid, "turn:item:compact");
  assert.equal(boundary.subtype, "compact_boundary");
  assert.deepEqual(boundary.compact_metadata, { pre_tokens: 12008, post_tokens: 5502 });
});

test("output file cards resolve delivery bindings without exposing snapshots", () => {
  const c = conversation();
  c.turns[0].items.unshift({
    id: "files",
    type: "outputFiles",
    generatedFiles: [
      {
        id: "sheet",
        name: "result.xlsx",
        path: "/work/result.xlsx",
        language: "text",
        operation: "create",
        state: "ready",
        bytes: 120,
        blob: true,
        digest: "PRIVATE_DIGEST",
      },
      {
        id: "gone",
        name: "gone.png",
        path: "/work/gone.png",
        language: "image",
        operation: "delete",
        state: "deleted",
        mime: "image/png",
      },
    ],
  });
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  const results = rows.filter((r) => r.toolUseResult?.attachments);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0].toolUseResult?.attachments, [
    { path: "result.xlsx", size: 120, isImage: false, unavailable: true },
  ]);
  assert.deepEqual(results[0].codeOutput, {
    turnId: "turn", itemId: "files", fileId: "sheet",
  });
  assert.equal(results[1].toolUseResult?.attachments[0].unavailable, true);
  assert.equal(results[1].toolUseResult?.attachments[0].isImage, true);
  const attachment = {
    path: "result.xlsx", size: 120, isImage: false,
    file_uuid: "405b74bf-73ef-451d-a761-b0179a792fb7",
  };
  const hydrated = hydrateCodeOutput(results[0], attachment);
  assert.equal(hydrated.uuid, results[0].uuid);
  assert.equal(hydrated.codeOutput, undefined);
  assert.deepEqual(hydrated.toolUseResult, { attachments: [attachment] });
  assert.deepEqual(hydrated.message.content, [{
    type: "tool_result", tool_use_id: "turn:activity:files:0",
    content: JSON.stringify({ attachments: [attachment] }), is_error: false,
  }]);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_DIGEST|\/work\/|"name":"Write"/);

  const cowork = convertCodeTranscript({ ...c, mode: "cowork" });
  const coworkOutput = cowork.rows.find((row) => row.uuid === results[0].uuid);
  assert.equal(coworkOutput?.codeOutput, undefined);
  assert.deepEqual(coworkOutput?.toolUseResult?.attachments, [
    { path: "/work/result.xlsx", size: 120, isImage: false },
  ]);
});

test("a saved generated image has a stable Code delivery row", () => {
  const c = conversation();
  c.turns[0].items.unshift({
    id: "image", type: "imageGeneration", lifecycleStatus: "completed",
    savedPath: "/private/runner/image.png", revisedPrompt: "PRIVATE_PROMPT",
  });

  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  assert.equal(rows[2].uuid, "turn:activity:image:0:result");
  assert.deepEqual(rows[2].codeOutput, { turnId: "turn", itemId: "image" });
  assert.deepEqual(rows[2].toolUseResult, {
    attachments: [{ path: "image.png", size: 0, isImage: true, unavailable: true }],
  });
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_PROMPT|\/private\/runner/);
});

for (const status of [
  "inProgress",
  "completed",
  "interrupted",
  "failed",
] as const)
  test(`public summary survives ${status} projection without leaking raw reasoning`, () => {
    const c = conversation();
    c.turns[0].status = status;
    c.turns[0].items = [
      {
        id: "r",
        type: "reasoning",
        summary: ["Public one", "Public two"],
        text: "RAW_TEXT_SENTINEL",
        content: ["RAW_CONTENT_SENTINEL"],
      } as any,
    ];
    const before = structuredClone(c);
    const result = convertCodeTranscript(c);
    assert.deepEqual(
      result.unsupported,
      status === "inProgress" ? ["running-turn"] : [],
    );
    assert.deepEqual(result.rows[1].message.content, [
      { type: "thinking", thinking: "Public one\n\nPublic two" },
    ]);
    assert.equal(JSON.stringify(result).includes("RAW_"), false);
    assert.equal("claudexSourceItem" in result.rows[1], false);
    assert.deepEqual(c, before);
    assert.deepEqual(
      convertCodeTranscript(JSON.parse(JSON.stringify(c))),
      result,
    );
    assert.equal(result.rows[1].uuid, "turn:item:r");
    assert.equal(result.rows[1].parentUuid, result.rows[0].uuid);
  });

for (const summary of [undefined, [], ["", "  \n"], [null], Array(3)])
  test("empty summary emits no fabricated thought or raw reasoning", () => {
    const c = conversation();
    c.turns[0].items = [
      {
        id: "r",
        type: "reasoning",
        summary,
        text: "RAW_TEXT",
        content: ["RAW_CONTENT"],
      } as any,
    ];
    const result = convertCodeTranscript(c);
    assert.equal(result.rows.length, 1);
    assert.equal(JSON.stringify(result).includes("RAW_"), false);
  });

test("malformed summary is not coerced to display text; valid sections retain order", () => {
  const c = conversation();
  c.turns[0].items = [
    {
      id: "r",
      type: "reasoning",
      summary: [null, "First", "  ", 4, { text: "Do not stringify" }, "Second"],
    } as any,
  ];
  const result = convertCodeTranscript(c);
  assert.deepEqual(result.unsupported, ["reasoning-summary"]);
  assert.deepEqual(result.rows[1].claudexReasoning, ["First", "Second"]);
  assert.deepEqual(result.rows[1].message.content, [
    { type: "thinking", thinking: "First\n\nSecond" },
  ]);
  c.turns[0].items[0].summary = "invalid" as any;
  const malformed = convertCodeTranscript(c);
  assert.equal(malformed.rows.length, 2);
  assert.deepEqual(malformed.rows[1].claudexUnsupported, ["reasoning-summary"]);
});
