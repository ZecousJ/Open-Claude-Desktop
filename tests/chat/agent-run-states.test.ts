import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationTranscript,
  backgroundTaskCount,
} from "../../src/transcript/ConversationTranscript";
import {
  CodeTurnStatus,
  codeStatus,
  ALMOST_DONE_SECONDS,
  thoughtSeconds,
} from "../../src/transcript/CodeTurnStatus";
import {
  THINKING_VERBS,
  clayVerb,
  turnVerb,
} from "../../src/transcript/TurnActivity";
import { thoughtTitle } from "../../src/transcript/ChatTurnContent";
import {
  codeSegments,
  toolSummary,
} from "../../src/code-tools/code-tool-model";
import type { Conversation, Item, Mode, Turn } from "../../shared/types";

const command = (id: string, extra: Partial<Item> = {}): Item => ({
  id,
  type: "commandExecution",
  command: "npm test",
  status: "completed",
  ...extra,
});
const read = (id: string, name: string): Item =>
  command(id, {
    command: `cat ${name}`,
    commandActions: [{ type: "read", name, path: `/r/${name}` }],
  });

function turn(extra: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    prompt: "Check the tests",
    attachments: [],
    createdAt: 1000,
    status: "completed",
    items: [{ id: "m", type: "agentMessage", text: "Done." }],
    ...extra,
  };
}
function conversation(mode: Mode, turns: Turn[]): Conversation {
  return {
    id: "c",
    title: "States",
    mode,
    cwd: mode === "code" ? "/r" : undefined,
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns,
  };
}
function render(c: Conversation, background: string[] = []) {
  return renderToStaticMarkup(
    createElement(ConversationTranscript, {
      conversation: c,
      mode: c.mode,
      sending: false,
      running: false,
      approvals: [],
      replyFeedback: {},
      onReplyFeedback: async () => {},
      onArtifact() {},
      onOpenWorkflow() {},
      onEditPrompt: async () => true,
      onRetryResponse() {},
      onContinue() {},
      onSelectVersion() {},
      onError() {},
      backgroundTerminals: background.map((itemId) => ({
        conversationId: c.id,
        itemId,
        processId: "1",
        command: "sleep 600",
      })) as any,
      scrollRef: createRef<HTMLDivElement>(),
      onScroll() {},
      onWheel() {},
      away: false,
      onJumpToLatest() {},
    }),
  );
}

test("a foreground command is not a running task; background work is (G-01)", () => {
  const t = turn({
    status: "inProgress",
    items: [command("fg", { status: "inProgress" }), command("bg")],
  });
  const c = conversation("code", [t]);
  assert.equal(backgroundTaskCount(t, c, new Set()), 0);
  assert.equal(backgroundTaskCount(t, c, new Set(["bg"])), 1);
  const status = codeStatus(t, 1000 + 30_000, false, 0);
  assert.deepEqual(status.meta, ["30s"]);
  assert.equal(status.leading, "Running");
  assert.equal(status.label, undefined);
  assert.equal(status.pulse, true);
});

test("a status line with nothing to show yet is not announced as waiting for input", () => {
  // Text streaming under 2 seconds: no label and no timer, only the count
  // of what has streamed ("Hello": 2 tokens).
  const streaming = turn({
    status: "inProgress",
    createdAt: Date.now(),
    items: [
      {
        id: "m",
        type: "agentMessage",
        text: "Hello",
        lifecycleStatus: "inProgress",
      },
    ],
  });
  const html = renderToStaticMarkup(
    createElement(CodeTurnStatus, { turn: streaming, awaitingApproval: false }),
  );
  assert.match(html, /role="status" aria-label="2 tokens"/);
  assert.doesNotMatch(html, /Needs your input/);
  const asking = renderToStaticMarkup(
    createElement(CodeTurnStatus, { turn: streaming, awaitingApproval: true }),
  );
  assert.match(asking, /aria-label="[^"]*Needs your input"/);
});

test("Code's retry line names the failure, and a plain dropped stream is the connection", () => {
  const retrying = (extra: Partial<Turn>) =>
    codeStatus(turn({ status: "inProgress", ...extra }), 1000 + 3_000).label;
  assert.equal(
    retrying({ reconnecting: "2/5" }),
    "Connection lost · Retrying (2/5)",
  );
  assert.equal(
    retrying({ reconnecting: "2/5", reconnectCause: "rate_limit" }),
    "Rate limit reached · Retrying (2/5)",
  );
  assert.equal(
    retrying({ reconnecting: "1/5", reconnectCause: "overloaded" }),
    "Server is busy · Retrying (1/5)",
  );
  assert.equal(
    retrying({
      reconnecting: "retrying",
      reconnectCause: "authentication_failed",
    }),
    "Authentication failed · Retrying…",
  );
  assert.equal(
    retrying({ reconnecting: "retrying" }),
    "Connection lost · Retrying…",
  );
});

test("Code's status labels: a plain Thinking however long it thinks", () => {
  const t = turn({
    status: "inProgress",
    items: [{ id: "r", type: "reasoning", lifecycleStatus: "inProgress" }],
  });
  assert.equal(codeStatus(t, 1000 + 5_000).label, "Thinking");
  assert.equal(codeStatus(t, 1000 + 15_000).label, "Thinking");
  assert.equal(ALMOST_DONE_SECONDS, 60);
  assert.equal(codeStatus(t, 1000 + 2_209_000).label, "Thinking");
  assert.deepEqual(codeStatus(t, 1000 + 2_209_000).meta, ["36m 49s"]);
  // A Stop that has not ended the turn yet, and a dropped event stream.
  assert.equal(
    codeStatus(t, 1000 + 5_000, false, 0, { stopping: true }).label,
    "Stopping…",
  );
  assert.equal(
    codeStatus(t, 1000 + 5_000, true, 0, { stopping: true }).label,
    "Stopping…",
  );
  assert.equal(
    codeStatus(t, 1000 + 5_000, false, 0, { connecting: true }).label,
    "Connecting…",
  );
  // "Thought for Ns" does not breathe.
  const done = turn({
    status: "inProgress",
    items: [
      {
        id: "r",
        type: "reasoning",
        lifecycleStatus: "completed",
        startedAt: 1000,
        completedAt: 28_000,
      },
    ],
  });
  const thought = codeStatus(done, 29_000);
  assert.equal(thought.label, "Thought for 27s");
  assert.equal(thought.pulse, false);
});

test("the status line drops its label while reply text streams (R-0808)", () => {
  const t = turn({
    status: "inProgress",
    items: [
      {
        id: "m",
        type: "agentMessage",
        text: "1. One",
        lifecycleStatus: "inProgress",
      },
    ],
  });
  t.outputTokens = 794;
  const status = codeStatus(t, 1000 + 34_000);
  // The reported count and the text still streaming ("1. One": 2 tokens).
  assert.deepEqual(status.meta, ["34s", "796 tokens"]);
  assert.equal(status.label, undefined);
});

test("a finished Code reply ends bare; earlier ones keep a hover toolbar (G-02, G-53, R-0638)", () => {
  const html = render(conversation("code", [turn({ id: "a" }), turn()]));
  // The still mark after a finished reply is gone.
  assert.doesNotMatch(html, /code-end-star/);
  // Only an earlier reply keeps its toolbar, shown on hover.
  assert.equal((html.match(/code-reply-actions/g) ?? []).length, 1);
  const background = render(
    conversation("code", [turn({ items: [command("bg")] })]),
    ["bg"],
  );
  assert.doesNotMatch(background, /code-end-star/);
  assert.match(background, /1 background task running/);
  assert.doesNotMatch(background, /code-spinner"[^>]*data-step/);
});

test("Chat and Cowork verbs are fixed per turn and never 'Starting' (G-04)", () => {
  const waiting = turn({ status: "inProgress", items: [] });
  const html = render(conversation("chat", [waiting]));
  // Beside the clay mark, the clay word in the chat word's place.
  assert.match(html, new RegExp(`>${clayVerb(turnVerb(waiting))}<`));
  assert.doesNotMatch(html, /Starting/);
  assert.ok(THINKING_VERBS.includes(turnVerb(waiting)));
  assert.equal(turnVerb(waiting), turnVerb({ id: waiting.id }));
});

test("reasoning titles come from the summary heading or first sentence (G-30)", () => {
  const r = (summary: string[]): Item[] => [
    { id: "r", type: "reasoning", summary },
  ];
  assert.equal(
    thoughtTitle(r(["**Explaining how streaming output works**\n\nBody"])),
    "Explaining how streaming output works",
  );
  assert.equal(
    thoughtTitle(r(["Checking the loader. Then the tests."])),
    "Checking the loader",
  );
  assert.equal(thoughtTitle(r([]), "Mulling"), "Mulling");
});

test("Cowork: no avatar star, an icon toolbar and no Workflow card (G-07, G-31, G-32)", () => {
  const html = render(
    conversation("cowork", [
      turn({
        items: [
          {
            id: "spawn",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            receiverThreadIds: ["a", "b"],
            workflowPhases: ["Review"],
            agentsStates: {
              a: { status: "running" },
              b: { status: "running" },
            },
          },
          { id: "m", type: "agentMessage", text: "Done." },
        ],
      }),
    ]),
  );
  assert.doesNotMatch(html, /assistant-mark/);
  assert.doesNotMatch(html, /workflow-card/);
  assert.match(html, /aria-label="Good response"/);
  assert.doesNotMatch(html, /aria-label="Retry/);
});

test("a /compact turn has no prompt bubble, toolbar or end mark (E0)", () => {
  const compaction = turn({
    id: "compact",
    prompt: "",
    compaction: "manual",
    items: [{ id: "cc", type: "contextCompaction", status: "completed" }],
  });
  for (const mode of ["chat", "code"] as const) {
    const html = render(conversation(mode, [turn({ id: "a" }), compaction]));
    const part = html.slice(html.indexOf("compaction-turn"));
    assert.doesNotMatch(part, /user-message/);
    assert.doesNotMatch(
      part,
      /message-actions|response-end-mark|code-end-star/,
    );
  }
});

test("a steered message renders as a user message where the model read it (E0)", () => {
  const html = render(
    conversation("chat", [
      turn({
        items: [
          { id: "m1", type: "agentMessage", text: "First part." },
          {
            id: "s",
            type: "userMessage",
            steered: true,
            clientId: "client",
            text: "Also check the docs",
            attachments: [],
          },
          { id: "m2", type: "agentMessage", text: "Second part." },
        ],
      }),
    ]),
  );
  const first = html.indexOf("First part.");
  const steered = html.indexOf("Also check the docs");
  assert.ok(first > 0 && steered > first);
  assert.ok(html.indexOf("Second part.") > steered);
  assert.match(html, /steered-message/);
});

test("Code tool runs keep first-seen order, count reads by file and take edits in (G-08, G-09)", () => {
  const edit: Item = {
    id: "e",
    type: "fileChange",
    status: "completed",
    changes: [{ path: "/r/app.js", kind: { type: "update" }, diff: "" }],
  };
  const items = [
    read("r1", "README.md"),
    read("r2", "app.js"),
    command("c"),
    edit,
  ];
  const segments = codeSegments(items);
  assert.equal(segments.length, 1);
  assert.equal(
    toolSummary(items),
    "Read 2 files, ran a command, edited a file",
  );
  const running = { ...edit, lifecycleStatus: "inProgress" as const };
  assert.equal(toolSummary([...items.slice(0, 3), running]), "Editing app.js");
  const ls = command("ls", {
    command: "ls",
    commandActions: [{ type: "listFiles", path: null }],
  });
  assert.equal(
    toolSummary([read("r1", "README.md"), ls, command("x", { exitCode: 1 })]),
    "Read README.md, ran 2 commands (1 failed)",
  );
});

test("a mixed group separates edited from created files and drops file names (R-0794)", () => {
  const change = (id: string, kind: string, path: string): Item => ({
    id,
    type: "fileChange",
    status: "completed",
    changes: [{ path, kind: { type: kind }, diff: "" }],
  });
  assert.equal(
    toolSummary([
      read("r1", "README.md"),
      read("r2", "app.js"),
      command("c"),
      change("e", "update", "/r/app.js"),
      change("n", "add", "/r/utils.js"),
    ]),
    "Read 2 files, ran a command, edited a file, created a file",
  );
  // A lone call or the call running now keeps its name.
  assert.equal(
    toolSummary([change("n", "add", "/r/utils.js")]),
    "Created utils.js",
  );
});

test("reasoning seen only once finished counts from where the model went quiet", () => {
  // GPT through Codex: the reasoning item appears when thinking is over, so
  // its own start and end are one moment; it thought since the command ended.
  const items: Item[] = [
    {
      id: "c",
      type: "commandExecution",
      command: "ls",
      lifecycleStatus: "completed",
      startedAt: 2_000,
      completedAt: 5_000,
    },
    {
      id: "r",
      type: "reasoning",
      lifecycleStatus: "completed",
      startedAt: 17_000,
      completedAt: 17_000,
    },
  ];
  assert.equal(thoughtSeconds(items, 1000), 12);
  // The first one counts from the turn's start.
  assert.equal(thoughtSeconds(items.slice(1), 1000), 16);
  // A notice under a second is not shown ("Thought for 0s").
  const quick = turn({
    status: "inProgress",
    items: [
      {
        id: "r",
        type: "reasoning",
        lifecycleStatus: "completed",
        startedAt: 1000,
        completedAt: 1000,
      },
      {
        id: "c",
        type: "commandExecution",
        command: "ls",
        lifecycleStatus: "inProgress",
        startedAt: 1000,
      },
    ],
  });
  assert.equal(codeStatus(quick, 1500).leading, "Running");
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());

test("the token count moves while a file is written, before the model reports its usage", async () => {
  const { streamingTokens } =
    await import("../../src/transcript/CodeTurnStatus");
  const writing = {
    id: "f",
    type: "fileChange",
    lifecycleStatus: "inProgress",
    changes: [{ path: "/w/index.html", kind: "add", diff: "a".repeat(400) }],
  } as Item;
  assert.equal(streamingTokens([writing]), 100);
  assert.equal(
    streamingTokens([{ ...writing, lifecycleStatus: "completed" } as Item]),
    0,
  );
  assert.equal(
    streamingTokens([
      {
        id: "m",
        type: "agentMessage",
        text: "你好世界",
        lifecycleStatus: "inProgress",
      } as Item,
    ]),
    3,
  );
});
