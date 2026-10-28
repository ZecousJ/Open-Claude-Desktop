import assert from "node:assert/strict";
import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import { preloadArtifactCard } from "../../src/artifacts/LazyArtifactCard";

// The document card loads lazily in the app; a static render needs it in.
before(() => preloadArtifactCard());
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTurnContent } from "../../src/transcript/ChatTurnContent";
import { chatSegments } from "../../src/transcript/ChatActivityGroup";
import { turnVerb } from "../../src/transcript/TurnActivity";
import type { Turn } from "../../shared/types";
const base = (): Turn => ({
  id: "t",
  prompt: "test",
  attachments: [],
  createdAt: Date.now(),
  status: "inProgress",
  items: [
    {
      id: "cmd",
      type: "commandExecution",
      command: "printf test",
      aggregatedOutput: "test",
      status: "completed",
      lifecycleStatus: "completed",
    },
  ],
});
const render = (turn: Turn, awaitingApproval = false) =>
  renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn,
      awaitingApproval,
      onArtifact: () => {},
    }),
  );

test("completed tool and continuing thought share one root disclosure without repeated command heading", () => {
  const turn = base();
  const html = render(turn);
  assert.equal((html.match(/class="chat-steps"/g) ?? []).length, 1);
  // The turn's verb heads the group while it works (G-04); the finished command
  // is a step in the open card.
  assert.match(html, new RegExp(turnVerb(turn)));
  assert.match(
    html,
    /<div class="chat-steps" data-running="true" data-open="true">/,
  );
  assert.match(
    html,
    /chat-step-text"><span class="activity-label">Ran a command/,
  );
  // The finished command's card opens from its row (closed until then).
  assert.match(html, /class="chat-step-row" aria-expanded="false"/);
  assert.equal((html.match(/class="command-card"/g) ?? []).length, 0);
});

test("active command becomes a completed disclosure when text starts streaming", () => {
  const turn = base();
  turn.items[0].lifecycleStatus = "inProgress";
  assert.match(render(turn), /Running a command/);
  turn.items[0].lifecycleStatus = "completed";
  turn.items.push({
    id: "m",
    type: "agentMessage",
    text: "Final answer",
    lifecycleStatus: "inProgress",
  });
  const html = render(turn);
  assert.match(html, /Ran a command/);
  assert.match(html, /Final answer/);
  assert.doesNotMatch(html, /Contemplating|Running a command/);
});

test("commentary keeps independent tool groups in chronological order", () => {
  const turn = base();
  turn.items.push(
    { id: "m", type: "agentMessage", text: "Between commands" },
    { ...turn.items[0], id: "next" },
  );
  assert.deepEqual(
    chatSegments(turn.items).map((s) => [s.id, s.activity]),
    [
      ["cmd", true],
      ["m", false],
      ["next", true],
    ],
  );
  const html = render(turn);
  assert(html.indexOf("Ran a command") < html.indexOf("Between commands"));
  assert(html.indexOf("Between commands") < html.indexOf(turnVerb(turn)));
});

// Rag_search, rag_read, a reasoning item without a summary, rag_search,
// rag_read ×2 and a command were two groups.
test("connector calls stay one group across a thought between them", () => {
  const tool = (id: string, name: string) => ({
    id,
    type: "mcpToolCall" as const,
    server: "knowledge_huaner_tech",
    tool: name,
    status: "completed",
  });
  const items = [
    tool("a", "rag_search"),
    tool("b", "rag_read"),
    { id: "r", type: "reasoning" as const, summary: [], content: [] },
    tool("c", "rag_search"),
    tool("d", "rag_read"),
    {
      id: "cmd",
      type: "commandExecution" as const,
      command: "python -c 1",
      status: "completed",
      lifecycleStatus: "completed",
    },
  ];
  const segments = chatSegments(items as Turn["items"]);
  assert.equal(segments.length, 1);
  assert.deepEqual(
    segments[0].items.map((i) => i.id),
    ["a", "b", "r", "c", "d", "cmd"],
  );
});

test("approval and interruption supersede misleading running states", () => {
  const turn = base();
  turn.items[0].lifecycleStatus = "inProgress";
  assert.match(render(turn, true), /Needs your input/);
  turn.status = "interrupted";
  const html = render(turn, true);
  // Settled and closed: what ran, then "Stopped" in the secondary ink.
  assert.match(html, /chat-steps-outcome" data-tone="secondary">Stopped</);
  assert.doesNotMatch(
    html,
    /Running a command|activity-mark|Waiting for output/,
  );
});

test("reasoning headings, or else the summary's first sentence, update the status", () => {
  const turn = base();
  turn.items.push({
    id: "r",
    type: "reasoning",
    lifecycleStatus: "inProgress",
    summary: ["**Checking the result**\nVerifying the synthetic output."],
  });
  assert.match(render(turn), /Checking the result/);
  // agent-lifecycle-001 17–21s: the label becomes the summary's first sentence (G-30).
  turn.items.at(-1)!.summary = [
    "A paragraph that is not a status heading. It goes on.",
  ];
  const html = render(turn);
  // The head drops the sentence's full stop; the running step keeps it.
  assert.match(
    html,
    /data-shimmer="thinking"><span class="shimmer-text"[^>]*>A paragraph that is not a status heading</,
  );
  assert.match(
    html,
    /chat-step-text"><span class="activity-label" data-shimmer="tools"><span class="shimmer-text"[^>]*>A paragraph that is not a status heading\.</,
  );
  // Thoughts open by default.
  assert.match(html, /class="chat-step" data-open="true"/);
  assert.doesNotMatch(html, /class="chat-step-peek"/);
  assert.match(html, /class="quiet-dots"/);
  assert.match(html, /It goes on/);
  turn.items.at(-1)!.summary = [];
  assert.match(render(turn), new RegExp(turnVerb(turn)));
});

test("a terminal failed turn settles legacy command progress before choosing the group label", () => {
  const turn = base();
  turn.status = "failed";
  turn.items[0].lifecycleStatus = "inProgress";
  const html = render(turn);
  // Settled: the row says what ran and "Failed" after it (84e60ffb); nothing
  // still reads as running.
  assert.match(html, /class="activity-label">Ran a command</);
  assert.match(html, /chat-steps-outcome"[^>]*>Failed</);
  assert.doesNotMatch(html, /Running a command|clay-mark|data-running/);
});

test("mixed activity renders a framed nested command and visible reasoning summary in chronological order", () => {
  const turn = base();
  turn.status = "completed";
  turn.items.push({
    id: "r",
    type: "reasoning",
    summary: ["Explaining how streaming output works."],
    lifecycleStatus: "completed",
  });
  // A finished group is closed: its row, no card.
  const html = render(turn);
  assert.match(html, /class="chat-steps-head" aria-expanded="false"/);
  assert.doesNotMatch(html, /chat-steps-card/);
  // Open while the turn runs: one card of steps, the command, then the
  // thought, in order.
  turn.status = "inProgress";
  const running = render(turn);
  assert.match(running, /chat-steps-card/);
  assert.equal((running.match(/class="chat-step"/g) ?? []).length, 2);
  assert(
    running.indexOf("Ran a command") <
      running.indexOf(
        "Explaining how streaming output works.",
        running.indexOf("chat-steps-card"),
      ),
  );
});

test("empty reasoning does not introduce a nested disclosure for a single command", () => {
  const turn = base();
  turn.status = "completed";
  turn.items.push({
    id: "r",
    type: "reasoning",
    summary: ["  "],
    lifecycleStatus: "completed",
  });
  turn.status = "inProgress";
  const html = render(turn);
  // The empty thought adds no step.
  assert.equal((html.match(/class="chat-step"/g) ?? []).length, 1);
});

test("adjacent file updates share a disclosure and one document card; commentary separates them", () => {
  const file = (id: string) => ({
    id,
    type: "fileChange",
    status: "completed",
    changes: [{ path: "card.html", kind: { type: "update" }, diff: "" }],
    generatedFiles: [
      {
        id,
        name: "card.html",
        path: "/fixture/card.html",
        language: "html",
        operation: "update" as const,
        state: "ready" as const,
        content: "<title>Card</title>" + id,
      },
    ],
  });
  const t = base();
  t.status = "completed";
  t.items = [file("first"), file("second")];
  const html = render(t);
  assert.equal((html.match(/class="chat-steps"/g) ?? []).length, 1);
  assert.equal((html.match(/file-document-card/g) ?? []).length, 1);
  assert.match(html, /Edited a file/);
  t.items.splice(1, 0, {
    id: "m",
    type: "agentMessage",
    text: "Between edits",
  });
  assert.equal(chatSegments(t.items).length, 3);
  // Each edit collapses to its own "Edited a file ›" row (G-11).
  assert.equal((render(t).match(/class="chat-steps"/g) ?? []).length, 2);
});

test("a finished Cowork group counts its reasoning notes; Chat does not (R-0849)", () => {
  const turn: Turn = {
    ...base(),
    status: "completed",
    items: [
      {
        id: "r",
        type: "reasoning",
        summary: ["**Waiting**\n\nThe command sleeps."],
        lifecycleStatus: "completed",
      },
      {
        id: "c",
        type: "commandExecution",
        command: "sleep 20",
        status: "completed",
        lifecycleStatus: "completed",
        exitCode: 0,
      },
    ],
  };
  const cowork = renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn,
      awaitingApproval: false,
      onArtifact: () => {},
      variant: "cowork",
    }),
  );
  assert.match(cowork, /Ran a command · 1 note/);
  assert.doesNotMatch(render(turn), /1 note/);
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());
