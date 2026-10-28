import assert from "node:assert/strict";
import test, { before } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Item, Turn } from "../../shared/types";
import { toolGroupSummary } from "../../src/transcript/tools/tool-group-summary";
import { thinkingQuote } from "../../src/code-tools/ThinkingInline";
import { CollaborationToolView } from "../../src/transcript/tools/CollaborationToolView";
import {
  ChatTurnContent,
  preloadChatSteps,
} from "../../src/transcript/ChatTurnContent";
import { codeStatus } from "../../src/transcript/CodeTurnStatus";
import { toolRunningLabel } from "../../src/transcript/tools/tool-running-label";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadChatSteps());
before(() => preloadMarkdownRenderer());

const tool = (name: string, extra: Partial<Item> = {}): Item => ({
  id: name,
  type: "dynamicToolCall",
  tool: name,
  status: "completed",
  ...extra,
});
const turn = (items: Item[], status: Turn["status"] = "completed"): Turn => ({
  id: "turn",
  prompt: "test",
  attachments: [],
  createdAt: 1000,
  status,
  items,
});

test("connector summaries count distinct integrations, not calls", () => {
  const calendar = tool("search", { type: "mcpToolCall", server: "Calendar" });
  assert.equal(toolGroupSummary([calendar]), "Used Calendar integration");
  assert.equal(
    toolGroupSummary([calendar, calendar]),
    "Used Calendar integration",
  );
  assert.equal(
    toolGroupSummary([calendar, { ...calendar, server: "Mail" }]),
    "Used 2 integrations",
  );
  assert.equal(
    toolGroupSummary([tool("mcp__Calendar__search", { type: "mcpToolCall" })]),
    "Used Calendar integration",
  );
});

test("summaries sort by call count, break ties in encounter order, and cap compact groups", () => {
  assert.equal(
    toolGroupSummary([tool("Write"), tool("Read"), tool("Read"), tool("Bash")]),
    "Read 2 files, created a file, ran a command",
  );
  const items = [
    tool("Write"),
    tool("Read"),
    tool("Bash"),
    tool("WebSearch"),
    tool("WebSearch"),
  ];
  assert.equal(
    toolGroupSummary(items),
    "Searched the web, created a file, and 2 more tools",
  );
  assert.equal(
    toolGroupSummary(items, true, true),
    "Searched the web, created a file, and 2 more steps",
  );
  assert.equal(
    toolGroupSummary(items, false),
    "Searched the web, created a file, read a file",
  );
  assert.equal(
    toolGroupSummary([tool("Unknown", { tool: undefined })]),
    "Used a tool",
  );
  assert.equal(
    toolGroupSummary([
      tool("Unknown", { tool: undefined }),
      tool("Unknown", { tool: undefined }),
    ]),
    "Used 2 tools",
  );
});

test("thought quotes preserve lines, quote blank lines, and estimate tokens using JS length", () => {
  assert.equal(
    thinkingQuote("First\n\nLast"),
    "> **Thinking** (~3 tok)\n>\n> First\n>\n> Last",
  );
  assert.equal(
    thinkingQuote("😀\r\nNext"),
    "> **Thinking** (~2 tok)\n>\n> 😀\n> Next",
  );
});

test("file summaries deduplicate paths but retain calls without paths", () => {
  const read = tool("Read", { arguments: { file_path: "/project/file" } });
  assert.equal(toolGroupSummary([read, read]), "Read a file");
  assert.equal(toolGroupSummary([read, read, tool("Read")]), "Read 2 files");
  assert.equal(
    toolGroupSummary([tool("Bash"), { id: "files", type: "outputFiles" }]),
    "Ran a command, shared files",
  );
});

test("expanded thoughts expose a separate accessible quote action", () => {
  const html = renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn: turn(
        [
          {
            id: "thought",
            type: "reasoning",
            summary: ["Checking the result."],
          },
        ],
        "inProgress",
      ),
      awaitingApproval: false,
      onArtifact: () => {},
    }),
  );
  assert.match(html, /role="group" aria-label="Thinking actions"/);
  assert.match(html, /aria-label="Copy as quote"/);
  assert.match(html, /class="[^"]*\bapp-icon\b/);
});

test("pending input labels appear on the status and pending tool row", () => {
  const pending = turn(
    [tool("AskUserQuestion", { status: "inProgress" })],
    "inProgress",
  );
  const html = renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn: pending,
      awaitingApproval: true,
      onArtifact: () => {},
    }),
  );
  assert.equal((html.match(/Needs your input/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Waiting for your response/);
  assert.equal(codeStatus(pending, 5000, true).label, "Needs your input");
});

test("agent calls use Code verbs and Chat multitasking copy", () => {
  for (const [status, expected] of [
    ["completed", "Ran agent"],
    ["inProgress", "Running agent"],
    ["failed", "Failed to run agent"],
  ]) {
    const item = tool("spawnAgent", { type: "collabAgentToolCall", status });
    assert.match(
      renderToStaticMarkup(createElement(CollaborationToolView, { item })),
      new RegExp(expected),
    );
  }
  for (const name of [
    "spawnAgent",
    "sendInput",
    "resumeAgent",
    "Agent",
    "Task",
    "SendMessage",
    "functions.spawn_agent",
  ])
    assert.equal(
      toolRunningLabel(tool(name, { status: "inProgress" })),
      "Multitasking…",
    );
  assert.match(
    renderToStaticMarkup(
      createElement(CollaborationToolView, {
        item: tool("spawnAgent", {
          type: "collabAgentToolCall",
          status: "inProgress",
        }),
        chat: true,
      }),
    ),
    /Multitasking…/,
  );
});

test("Code's reconnect line names the retried failure, else the lost connection", () => {
  const retrying = (
    reconnecting: string,
    reconnectCause?: "authentication_failed" | "rate_limit" | "overloaded",
  ) => ({
    ...turn([], "inProgress"),
    reconnecting,
    ...(reconnectCause ? { reconnectCause } : {}),
  });
  assert.equal(
    codeStatus(retrying("2/5"), 5000).label,
    "Connection lost · Retrying (2/5)",
  );
  assert.equal(
    codeStatus(retrying("2/5", "rate_limit"), 5000).label,
    "Rate limit reached · Retrying (2/5)",
  );
  assert.equal(
    codeStatus(retrying("retrying", "overloaded"), 5000).label,
    "Server is busy · Retrying…",
  );
});
