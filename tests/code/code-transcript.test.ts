import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tokenizeShell } from "../../src/transcript/tools/shell-highlight";
import { codeStatusParts } from "../../src/transcript/CodeTurnStatus";
import { CodeCommandActivity } from "../../src/code-tools/CodeCommandActivity";
import {
  CodeUserMessage,
  codePromptClampChars,
} from "../../src/transcript/CodeUserMessage";
import { recordItemLifecycle, recordTurnUsage } from "../../shared/activity";
import type { Turn } from "../../shared/types";

const kinds = (source: string) =>
  tokenizeShell(source)
    .filter((token) => token.kind !== "space")
    .map((token) => `${token.kind}:${token.text}`);

test("shell tokens classify commands, keywords, list words, numbers and strings", () => {
  assert.deepEqual(
    kinds('for i in 1 2; do [ "$i" -gt 1 ] && sleep 1; echo "tick $i"; done'),
    [
      "keyword:for",
      "arg:i",
      "keyword:in",
      "list:1",
      "list:2",
      "operator:;",
      "keyword:do",
      "operator:[",
      'string:"$i"',
      "arg:-gt",
      "number:1",
      "operator:]",
      "operator:&&",
      "command:sleep",
      "number:1",
      "operator:;",
      "command:echo",
      'string:"tick $i"',
      "operator:;",
      "keyword:done",
    ],
  );
  assert.deepEqual(kinds("printf '%s' x | sha256sum 2>&1"), [
    "command:printf",
    "string:'%s'",
    "arg:x",
    "operator:|",
    "command:sha256sum",
    "operator:2>&1",
  ]);
});

test("code status follows the reference phase wording", () => {
  const start = 1_000_000;
  const turn: Turn = {
    id: "t",
    prompt: "",
    attachments: [],
    createdAt: start,
    status: "inProgress",
    items: [],
  };
  assert.deepEqual(codeStatusParts(turn, start + 1500), [
    "Waiting for Claudex…",
  ]);
  turn.items.push({
    id: "r",
    type: "reasoning",
    lifecycleStatus: "inProgress",
    startedAt: start + 2000,
  });
  // A plain "Thinking" after the timer.
  assert.deepEqual(codeStatusParts(turn, start + 4200), ["4s", "Thinking"]);
  assert.deepEqual(codeStatusParts(turn, start + 17000), ["17s", "Thinking"]);
  Object.assign(turn.items[0], {
    lifecycleStatus: "completed",
    completedAt: start + 29000,
  });
  turn.items.push({
    id: "c",
    type: "commandExecution",
    command: "true",
    lifecycleStatus: "inProgress",
  });
  turn.outputTokens = 36;
  // A running tool's word leads the line ("Running 36s · 36 tokens").
  assert.deepEqual(codeStatusParts(turn, start + 30000, false, 0), [
    "Running",
    "30s",
    "36 tokens",
    "Thought for 27s",
  ]);
  assert.deepEqual(codeStatusParts(turn, start + 36000, false, 1), [
    "Running",
    "36s",
    "36 tokens",
    "1 background task running",
  ]);
});

test("turn usage and item observation times are recorded without reviving finished turns", () => {
  const turn: Turn = {
    id: "t",
    prompt: "",
    attachments: [],
    createdAt: 0,
    status: "inProgress",
    items: [],
  };
  recordItemLifecycle(turn, { id: "r", type: "reasoning" }, false, 10);
  recordItemLifecycle(turn, { id: "r", type: "reasoning" }, true, 40);
  assert.equal(turn.items[0].startedAt, 10);
  assert.equal(turn.items[0].completedAt, 40);
  assert.equal(
    recordTurnUsage(turn, {
      total: { outputTokens: 136 },
      last: { outputTokens: 36 },
    }),
    true,
  );
  assert.equal(turn.outputTokens, 36);
  recordTurnUsage(turn, {
    total: { outputTokens: 150 },
    last: { outputTokens: 14 },
  });
  assert.equal(turn.outputTokens, 50);
  turn.status = "completed";
  assert.equal(recordTurnUsage(turn, { total: { outputTokens: 999 } }), false);
});

test("turn usage also keeps this turn's uncached input tokens", () => {
  const turn: Turn = {
    id: "t",
    prompt: "",
    attachments: [],
    createdAt: 0,
    status: "inProgress",
    items: [],
  };
  recordTurnUsage(turn, {
    total: { outputTokens: 100, inputTokens: 5000, cachedInputTokens: 3000 },
    last: { outputTokens: 20, inputTokens: 1500, cachedInputTokens: 1000 },
  });
  assert.equal(turn.outputTokens, 20);
  assert.equal(turn.inputTokens, 500);
  recordTurnUsage(turn, {
    total: { outputTokens: 130, inputTokens: 6200, cachedInputTokens: 3900 },
    last: { outputTokens: 30, inputTokens: 1200, cachedInputTokens: 900 },
  });
  assert.equal(turn.outputTokens, 50);
  assert.equal(turn.inputTokens, 800);
});

test("code command card shows description, Bash title, prompt and plain output", () => {
  const html = renderToStaticMarkup(
    createElement(CodeCommandActivity, {
      item: {
        id: "c",
        type: "commandExecution",
        description: "Printed tick",
        command: 'echo "tick"',
        aggregatedOutput: "tick\n",
        lifecycleStatus: "completed",
      },
    }),
  );
  assert.match(html, /Printed tick/);
  assert.match(html, /code-bash-title">Bash</);
  assert.match(html, /code-bash-prompt">\$ </);
  assert.match(html, /code-bash-output">tick</);
  assert.doesNotMatch(html, /Output</);
});

test("a Code prompt over 1200 characters folds behind Show more", () => {
  const turn = (prompt: string): Turn => ({
    id: "t",
    prompt,
    attachments: [],
    status: "completed",
    createdAt: 0,
    items: [],
  });
  const long = "x".repeat(codePromptClampChars + 1);
  const folded = renderToStaticMarkup(
    createElement(CodeUserMessage, { turn: turn(long), foldLong: true }),
  );
  assert.match(folded, /user-message-text is-clamped" inert=""/);
  assert.match(folded, /aria-expanded="false"[^>]*>Show more</);
  // At the threshold, or outside Code, the prompt shows whole.
  for (const html of [
    renderToStaticMarkup(
      createElement(CodeUserMessage, {
        turn: turn("x".repeat(codePromptClampChars)),
        foldLong: true,
      }),
    ),
    renderToStaticMarkup(createElement(CodeUserMessage, { turn: turn(long) })),
  ]) {
    assert.doesNotMatch(html, /is-clamped|Show more/);
  }
});

test("polling a background terminal reads as task output (R-0821)", () => {
  const poll = {
    id: "poll",
    type: "commandExecution",
    command: "npm run build",
    source: "unifiedExecInteraction",
    processId: "77",
    lifecycleStatus: "inProgress" as const,
  };
  assert.match(
    renderToStaticMarkup(createElement(CodeCommandActivity, { item: poll })),
    />Reading task output</,
  );
  assert.match(
    renderToStaticMarkup(
      createElement(CodeCommandActivity, {
        item: { ...poll, lifecycleStatus: "completed" as const },
      }),
    ),
    />Read task output</,
  );
});
