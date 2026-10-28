import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTranscript } from "../../src/transcript/ConversationTranscript";
import { failedRuns } from "../../src/transcript/TurnOutcome";
import { setLocale } from "../../src/i18n";
import type { Conversation, Mode, Turn } from "../../shared/types";
import { preloadCodeTurnError } from "../../src/transcript/TurnOutcome";

before(() => preloadCodeTurnError());

const turn = (id: string, extra: Partial<Turn> = {}): Turn => ({
  id,
  prompt: `Prompt ${id}`,
  attachments: [],
  createdAt: 1000,
  status: "completed",
  items: [{ id: `${id}-m`, type: "agentMessage", text: "Done." }],
  ...extra,
});
const failed = (
  id: string,
  error = "something odd",
  extra: Partial<Turn> = {},
) => turn(id, { status: "failed", error, items: [], ...extra });

function render(mode: Mode, turns: Turn[]) {
  const conversation: Conversation = {
    id: "c",
    title: "Failures",
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
  return renderToStaticMarkup(
    createElement(ConversationTranscript, {
      conversation,
      mode,
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
      scrollRef: createRef<HTMLDivElement>(),
      onScroll() {},
      onWheel() {},
      away: false,
      onJumpToLatest() {},
    }),
  );
}

test("failed replies in a row with no known reason fold into one count", () => {
  const runs = failedRuns([
    turn("a"),
    failed("b"),
    failed("c"),
    failed("d"),
    turn("e"),
    failed("f"),
  ]);
  assert.deepEqual(
    [...runs],
    [
      ["b", 0],
      ["c", 0],
      ["d", 3],
    ],
  );
});

test("a named reason, written text or the output limit breaks the run", () => {
  assert.equal(failedRuns([failed("a"), failed("b", "fetch failed")]).size, 0);
  assert.equal(
    failedRuns([
      failed("a"),
      failed("b", "odd", {
        items: [{ id: "m", type: "agentMessage", text: "Half" }],
      }),
    ]).size,
    0,
  );
  assert.equal(
    failedRuns([failed("a"), failed("b", "odd", { stopReason: "length" })])
      .size,
    0,
  );
  assert.equal(
    failedRuns([failed("a"), turn("b", { status: "interrupted", items: [] })])
      .size,
    0,
  );
});

test("Chat shows one notice for the run, under its last reply", () => {
  const html = render("chat", [failed("a"), failed("b")]);
  assert.equal(html.match(/data-notice="reply"/g)?.length, 1);
  assert.match(html, /2 responses didn’t load\./);
  assert.doesNotMatch(html, /This response didn’t load\./);
  // The last reply keeps its way on.
  assert.match(html, />Try again</);
});

test("one failed reply keeps its own sentence; Code never folds", () => {
  assert.match(
    render("chat", [turn("a"), failed("b")]),
    /This response didn’t load\./,
  );
  // Each failed Code turn has its own card: the headline, and the hint without
  // Try again but the last.
  const code = render("code", [failed("a"), failed("b")]);
  assert.equal(code.match(/Something went wrong/g)?.length, 2);
  assert.equal(code.match(/Try sending your message again\./g)?.length, 2);
  assert.doesNotMatch(code, /responses didn’t load/);
});

test("the folded count sentence follows the chosen language", async () => {
  await setLocale("zh-CN");
  try {
    assert.match(
      render("chat", [failed("a"), failed("b")]),
      /2 条回复未能加载。/,
    );
  } finally {
    await setLocale("en-US");
  }
});
