import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnOutcome, failedRuns } from "../../src/transcript/TurnOutcome";
import { UserMessage } from "../../src/transcript/UserMessage";
import { CodeUserMessage } from "../../src/transcript/CodeUserMessage";
import { SentPromptDialog } from "../../src/transcript/SentPromptDialog";
import type { Conversation, Turn } from "../../shared/types";
import { preloadCodeTurnError } from "../../src/transcript/TurnOutcome";

before(() => preloadCodeTurnError());

const turn = (extra: Partial<Turn> = {}): Turn => ({
  id: "t",
  prompt: "hello",
  attachments: [],
  items: [],
  status: "completed",
  createdAt: 1,
  ...extra,
});
const outcome = (value: Turn, extra = {}) =>
  renderToStaticMarkup(
    createElement(TurnOutcome, {
      turn: value,
      mode: "chat",
      latest: true,
      busy: false,
      onRetry() {},
      onContinue() {},
      onNewChat() {},
      ...extra,
    }),
  );
const prompt = (value: Turn, extra = {}) =>
  renderToStaticMarkup(
    createElement(UserMessage, {
      turn: value,
      conversation: { id: "c", turns: [value] } as Conversation,
      busy: false,
      onEdit: async () => true,
      onRetry() {},
      onDiscard() {},
      onSelect() {},
      ...extra,
    }),
  );

test("Chat context-full errors show the official copy and a working new-chat action", () => {
  const value = turn({
    status: "failed",
    stopReason: "conversation_length_limit",
  });
  const html = outcome(value);
  assert.match(html, /This chat is full\. Start a new chat to keep going\./);
  assert.match(html, /<button[^>]*>Start a new chat<\/button>/);
  assert.doesNotMatch(html, /Try again|Continue/);
  assert.doesNotMatch(outcome(value, { latest: false }), /<button/);
  assert.match(outcome(value, { busy: true }), /disabled/);
  assert.match(
    outcome(turn({ status: "failed", error: "context_length_exceeded" })),
    /This chat is full/,
  );
});

test("the full-chat action invokes the supplied navigation callback", () => {
  let opened = false;
  const banner = TurnOutcome({
    turn: turn({ status: "failed", stopReason: "conversation_length_limit" }),
    mode: "chat",
    latest: true,
    busy: false,
    onRetry() {},
    onContinue() {},
    onNewChat() {
      opened = true;
    },
  });
  assert.ok(banner);
  banner.props.buttons[0].onClick();
  assert.equal(opened, true);
});

test("failed-send controls do not appear for a failed response and never double its error", () => {
  const value = turn({ status: "failed", sendFailed: true });
  assert.match(prompt(value), /Failed to send/);
  assert.match(prompt(value), /data-testid="failed-send-discard"/);
  assert.match(prompt(value, { busy: true }), /disabled/);
  // Retry and Discard are in the failed row once; the toolbar adds none.
  const html = prompt(value);
  assert.equal(html.match(/data-testid="failed-send-retry"/g)?.length, 1);
  assert.equal(html.match(/data-testid="failed-send-discard"/g)?.length, 1);
  assert.doesNotMatch(html, /aria-label="Retry"/);
  assert.doesNotMatch(prompt(turn({ status: "failed" })), /Failed to send/);
  assert.equal(outcome(value), "");
  assert.equal(failedRuns([value, turn({ ...value, id: "t2" })]).size, 0);
});

test("prompt action labels and the raw-originals trigger match the reference", () => {
  assert.match(prompt(turn()), /aria-label="Retry"/);
  assert.doesNotMatch(prompt(turn()), /View sent prompt|Retry message/);
  assert.match(
    prompt(turn({ rawOriginals: ["raw"] })),
    /aria-label="View sent prompt"/,
  );
  assert.match(
    renderToStaticMarkup(
      createElement(CodeUserMessage, { turn: turn({ rawOriginals: ["raw"] }) }),
    ),
    /aria-label="View sent prompt"/,
  );
});

test("Sent prompt renders separate verbatim blocks without interpreting markup", () => {
  const html = renderToStaticMarkup(
    createElement(SentPromptDialog, {
      prompts: ["<b>raw</b>\n  text", "second"],
      onClose() {},
    }),
  );
  assert.match(html, /aria-label="Sent prompt"/);
  assert.match(
    html,
    /The exact text Claudex received for this message, shown verbatim\./,
  );
  assert.match(html, /<pre>&lt;b&gt;raw&lt;\/b&gt;\n  text<\/pre>/);
  assert.match(html, /<pre>second<\/pre>/);
});

test("reconnecting remains a status and Code interruptions use the session title", () => {
  assert.match(
    outcome(turn({ status: "inProgress", reconnecting: "2/5" })),
    /role="status".*Retrying now \(attempt 2 of 5\)/,
  );
  assert.match(
    outcome(turn({ status: "interrupted" }), { mode: "code" }),
    /Session was interrupted/,
  );
  assert.match(
    outcome(turn({ status: "interrupted" })),
    /Claudex’s response was interrupted/,
  );
});
