import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createElement as h, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ConversationTranscript } from "../../src/transcript/ConversationTranscript";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import { preloadCodeTurnError } from "../../src/transcript/TurnOutcome";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import type { Conversation } from "../../shared/types";

const normalFonts = ["Sans", "Serif"].map((family) => ({
  family: `Claudex Reference ${family}`,
  style: "normal" as const,
  data: new Uint8Array([0, 1, 0, 0]),
}));

function fontEnvironment(failItalic = false) {
  const { document } = parseHTML("<html><body></body></html>");
  const added: MockFace[] = [];
  const pending: MockFace[] = [];
  class MockFace {
    constructor(
      readonly family: string,
      readonly source: ArrayBuffer,
      readonly descriptors: FontFaceDescriptors,
    ) {
      pending.push(this);
    }
    async load() {
      if (failItalic && this.descriptors.style === "italic")
        throw new Error("Unreadable italic font");
      return this;
    }
  }
  Object.defineProperty(document, "fonts", {
    value: { add: (face: MockFace) => added.push(face) },
  });
  return {
    document,
    added,
    pending,
    Face: MockFace as unknown as typeof FontFace,
  };
}

before(async () => {
  await Promise.all([
    preloadChatSteps(),
    preloadMarkdownRenderer(),
    preloadCodeTurnError(),
  ]);
});

function transcript(conversation: Conversation, presentation?: "chat") {
  const noop = () => {};
  return parseHTML(
    `<html><body>${renderToStaticMarkup(
      h(ConversationTranscript, {
        conversation,
        mode: conversation.mode,
        presentation,
        sending: false,
        running: false,
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
    )}</body></html>`,
  ).document;
}

test("a stored Cowork execution uses current Chat message presentation while retaining its independent task capabilities", () => {
  const fixture = fixtureSnapshot({ states: true });
  const value = structuredClone(
    fixture.conversations.find((item) => item.id === "c-run-cowork")!,
  );
  value.turns[0].status = "completed";
  const original = structuredClone(value);
  const current = transcript(value, "chat");
  assert.ok(current.querySelector(".chat-steps"));
  assert.equal(current.querySelector(".agent-activity-group"), null);
  assert.equal(
    current.querySelectorAll('[role="feed"] [role="article"]').length,
    2,
  );
  assert.deepEqual(
    [...current.querySelectorAll('[role="article"]')].map((message) =>
      message.getAttribute("aria-label"),
    ),
    ["Message 1 of 2", "Message 2 of 2"],
  );
  assert.ok(
    current
      .querySelector(".assistant-message .message-summary")
      ?.textContent?.startsWith("Claudex responded:"),
  );
  // Merged into Chat, its reply has Chat's actions.
  assert.equal(
    current.querySelector('.message-actions button[aria-label="More options"]'),
    null,
  );
  assert.ok(
    current.querySelector('.message-actions button[aria-label="Retry"]'),
  );
  const legacy = transcript(value);
  assert.ok(legacy.querySelector(".agent-activity-group"));
  assert.equal(legacy.querySelector(".chat-steps"), null);
  assert.deepEqual(value, original);
});
