import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createElement as h, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Conversation, Turn } from "../../shared/types";
import { ReplyToolbar } from "../../src/transcript/ReplyToolbar";
import { ConversationTranscript } from "../../src/transcript/ConversationTranscript";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import { preloadCodeTurnError } from "../../src/transcript/TurnOutcome";

before(async () => {
  await Promise.all([
    preloadChatSteps(),
    preloadMarkdownRenderer(),
    preloadCodeTurnError(),
  ]);
});
const noop = () => {};
const turn = (id: string, patch: Partial<Turn> = {}): Turn => ({
  id,
  prompt: `Prompt ${id}`,
  createdAt: 1,
  attachments: [],
  status: "completed",
  items: [{ id: `${id}-reply`, type: "agentMessage", text: `Reply ${id}` }],
  ...patch,
});
const conversation = (
  turns: Turn[],
  patch: Partial<Conversation> = {},
): Conversation => ({
  id: "toolbar-condition-fixture",
  title: "Offline toolbar conditions",
  mode: "chat",
  providerId: "fixture",
  model: "Opus 5.5",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns,
  ...patch,
});
function render(
  node: Parameters<typeof renderToStaticMarkup>[0],
  speech = true,
) {
  const globals = {
    window: speech ? { speechSynthesis: {} } : {},
    SpeechSynthesisUtterance: speech ? class {} : undefined,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  try {
    return parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`)
      .document;
  } finally {
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
}
function toolbar(
  value: Conversation,
  current = value.turns[0]!,
  busy = false,
  speech = true,
) {
  return render(
    h(ReplyToolbar, {
      conversation: value,
      turn: current,
      busy,
      onRating: async () => {},
      onRetry: noop,
      onSelect: noop,
      onError: noop,
    }),
    speech,
  );
}
function transcript(value: Conversation, running = false) {
  return render(
    h(ConversationTranscript, {
      conversation: value,
      mode: value.mode,
      presentation: "chat",
      sending: false,
      running,
      approvals: [],
      replyFeedback: {},
      onReplyFeedback: async () => {},
      onArtifact: noop,
      onOpenWorkflow: noop,
      onEditPrompt: async () => true,
      onRetryResponse: noop,
      onContinue: noop,
      onSelectVersion: noop,
      onError: noop,
      scrollRef: createRef<HTMLDivElement>(),
      onScroll: noop,
      onWheel: noop,
      away: false,
      onJumpToLatest: noop,
    }),
  );
}
const buttons = (row: Element) =>
  [...row.querySelectorAll("button[aria-label]")].map((button) =>
    button.getAttribute("aria-label"),
  );

test("actual completed reply toolbar preserves Copy, Read aloud, ratings, Retry and a separate timestamp", () => {
  const value = conversation([turn("plain")]);
  const document = toolbar(value);
  assert.deepEqual(buttons(document.querySelector(".message-actions")!), [
    "Copy",
    "Read aloud",
    "Good response",
    "Bad response",
    "Retry",
  ]);
  assert.ok(document.querySelector(".reply-time"));
  assert.equal(document.querySelector(".reply-versions, .reply-more"), null);
});

test("real speech availability and incognito suppress only their own ordinary reply controls", () => {
  const value = conversation([turn("private")], { incognito: true });
  const privateRow = toolbar(value).querySelector(".message-actions")!;
  assert.deepEqual(buttons(privateRow), ["Copy", "Read aloud", "Retry"]);
  const unavailable = toolbar(
    conversation([turn("without-speech")]),
    undefined,
    false,
    false,
  );
  assert.deepEqual(buttons(unavailable.querySelector(".message-actions")!), [
    "Copy",
    "Good response",
    "Bad response",
    "Retry",
  ]);
});

test("historical reply alternatives stay mounted during local global busy while the existing backend capability guard disables mutations", () => {
  const older = turn("older", { responseGroupId: "answer-group" });
  const alternative = turn("alternative", {
    createdAt: 2,
    responseGroupId: "answer-group",
  });
  const value = conversation(
    [older, turn("latest", { status: "inProgress" })],
    {
      savedBranches: [
        {
          id: "alternate-branch",
          providerId: "fixture",
          model: "Opus 5.5",
          turns: [alternative],
          visited: 0,
        },
      ],
    },
  );
  const idle = toolbar(value, older);
  assert.equal(
    idle.querySelector<HTMLButtonElement>('button[aria-label="Retry"]')!
      .disabled,
    false,
  );
  assert.match(idle.querySelector(".reply-versions")!.textContent!, /1 \/ 2/);
  const busy = toolbar(value, older, true);
  for (const label of ["Retry", "Previous version", "Next version"]) {
    const button = busy.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    assert.ok(button, `${label} is retained, not globally removed`);
    assert.equal(button.disabled, true);
  }
  for (const label of ["Copy", "Read aloud", "Good response", "Bad response"])
    assert.equal(
      busy.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
        .disabled,
      false,
    );
});

test("actual transcript keeps the historical tool-rich reply toolbar while the new live reply has no completed toolbar", () => {
  const older = turn("tools", {
    items: [
      {
        id: "thought",
        type: "reasoning",
        summary: ["Inspecting the offline fixture"],
      },
      {
        id: "command",
        type: "commandExecution",
        command: "wc -l notes.txt",
        aggregatedOutput: "12 notes.txt",
        lifecycleStatus: "completed",
      },
      {
        id: "answer",
        type: "agentMessage",
        text: "The file has twelve lines.",
      },
    ],
  });
  const value = conversation([
    older,
    turn("live", { status: "inProgress", items: [] }),
  ]);
  const document = transcript(value, true);
  const oldRow = document.querySelector(
    '.turn[data-latest="false"] .assistant-message',
  )!;
  assert.ok(oldRow.querySelector(".chat-steps"));
  assert.deepEqual(buttons(oldRow.querySelector(".message-actions")!), [
    "Copy",
    "Read aloud",
    "Good response",
    "Bad response",
    "Retry",
  ]);
  assert.equal(
    document.querySelector(
      '.turn[data-latest="true"] .assistant-message .message-actions',
    ),
    null,
  );
  assert.equal(
    document.querySelectorAll('.assistant-message[role="article"]').length,
    2,
  );
});

test("compaction and Code keep their actual independent toolbar conditions", () => {
  const compact = transcript(
    conversation([turn("compact", { compaction: "manual" })]),
  );
  assert.equal(compact.querySelector(".message-actions"), null);
  const code = transcript(
    conversation([turn("older-code"), turn("latest-code")], { mode: "code" }),
  );
  const earlier = code.querySelector(
    '.turn[data-latest="false"] .code-reply-actions',
  )!;
  assert.deepEqual(buttons(earlier), [
    "Copy",
    "Fork from here",
    "Pin as chapter",
  ]);
  assert.equal(
    code.querySelector('.turn[data-latest="true"] .code-reply-actions'),
    null,
  );
  assert.equal(
    code.querySelector(
      'button[aria-label="Read aloud"], button[aria-label="Retry"]',
    ),
    null,
  );
});
