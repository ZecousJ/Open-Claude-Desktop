import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import type { Conversation } from "../../shared/types";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ConversationTranscript } from "../../src/transcript/ConversationTranscript";
import { AssistantMessage } from "../../src/transcript/AssistantMessage";
import { UserMessage } from "../../src/transcript/UserMessage";
import { readFileSync } from "node:fs";
import { messageSummary } from "../../src/transcript/message-summary";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";

before(() => Promise.all([preloadMarkdownRenderer(), preloadChatSteps()]));
const noop = () => {};
function fixture(mode: Conversation["mode"] = "chat") {
  const snapshot = fixtureSnapshot({ states: true });
  const conversation = structuredClone(
    snapshot.conversations.find((c) => c.id === "c-run-chat")!,
  );
  conversation.mode = mode;
  conversation.turns = [
    {
      ...conversation.turns[0],
      id: "first-turn",
      prompt: "Hello there. Another sentence.",
      status: "completed",
      items: [
        {
          id: "first-reply",
          type: "agentMessage",
          text: "A **clear** reply. More detail.",
        },
      ],
    },
  ];
  return { snapshot, conversation };
}
function transcript(
  mode: Conversation["mode"],
  size?: "s" | "m" | "l",
  busy = false,
  unified = true,
) {
  const { snapshot, conversation } = fixture(mode);
  snapshot.settings.transcriptTextSize = size;
  if (busy)
    conversation.turns.push({
      ...structuredClone(conversation.turns[0]),
      id: "live-turn",
      prompt: "Continue",
      status: "inProgress",
      items: [
        {
          id: "live-reply",
          type: "agentMessage",
          text: "Live reply.",
          lifecycleStatus: "inProgress",
        },
      ],
    });
  const app = { snapshot } as unknown as AppController;
  const html = renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(ConversationTranscript, {
        conversation,
        mode,
        presentation: unified ? "chat" : undefined,
        sending: false,
        running: busy,
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
    ),
  );
  return parseHTML(`<html><body>${html}</body></html>`).document;
}

test("source summary normalization uses the first plain sentence/line and the 160-character limit", () => {
  assert.equal(
    messageSummary("\n# A **clear** reply. Another sentence."),
    "A clear reply.",
  );
  assert.equal(
    messageSummary(
      "\n```js\nsecret code\n```\n\n[Readable](https://example.test) text\nNext line",
    ),
    "Readable text",
  );
  assert.equal(
    messageSummary("- A `code` and _plain_ label! More."),
    "A code and plain label!",
  );
  assert.equal(messageSummary("a".repeat(161)), `${"a".repeat(159)}…`);
  assert.equal(
    messageSummary(
      "1. A circle has no corners.\n2. A square has four equal sides.",
    ),
    "A circle has no corners.",
  );
  assert.equal(messageSummary("\n\n"), "");
});

test("ordinary Medium replies keep the actual unbubbled frame and existing per-message articles", () => {
  const document = transcript("chat");
  const frame = document.querySelector('[data-cds="AssistantMessage"]')!;
  assert.ok(frame);
  for (const name of [
    "data-busy",
    "data-text-size",
    "data-variant",
    "data-cds-bubble-stack",
    "aria-busy",
    "role",
    "aria-label",
  ])
    assert.equal(frame.getAttribute(name), null, name);
  const title = frame.querySelector("h2.message-summary")!;
  assert.equal(title.textContent, "Claudex responded: A clear reply.");
  assert.equal(title.getAttribute("aria-hidden"), null);
  assert.ok(title.hasAttribute("data-find-omitted"));
  assert.equal(document.querySelectorAll('[role="article"]').length, 2);
  assert.equal(
    frame.closest('[role="article"]')?.getAttribute("aria-label"),
    "Message 2 of 2",
  );
  assert.equal(
    document.querySelector(".user-message-article > h2.message-summary")
      ?.textContent,
    "You said: Hello there.",
  );
  assert.ok(document.querySelector('.user-message[data-cds="UserMessage"]'));
});

test("Small/Medium/Large metadata reaches the real prompt and assistant frame in unified Chat and stored Cowork", () => {
  for (const mode of ["chat", "cowork"] as const)
    for (const [size, expected] of [
      ["s", "sm"],
      ["m", null],
      ["l", "lg"],
    ] as const) {
      const document = transcript(mode, size);
      assert.equal(
        document
          .querySelector('[data-cds="AssistantMessage"]')
          ?.getAttribute("data-text-size"),
        expected,
        `${mode}/${size}`,
      );
      assert.equal(
        document
          .querySelector('[data-cds="UserMessage"]')
          ?.getAttribute("data-text-size"),
        expected,
        `${mode}/${size}`,
      );
      assert.equal(
        document
          .querySelector('[data-cds="AssistantMessage"]')
          ?.getAttribute("data-cds-bubble-stack"),
        null,
      );
    }
});

test("busy belongs to the actual live turn and hides only its summary heading", () => {
  const document = transcript("chat", "l", true);
  const frames = [
    ...document.querySelectorAll('[data-cds="AssistantMessage"]'),
  ];
  assert.equal(frames.length, 2);
  assert.equal(frames[0].getAttribute("data-busy"), null);
  assert.equal(
    frames[0].querySelector("h2")?.textContent,
    "Claudex responded: A clear reply.",
  );
  assert.equal(frames[1].getAttribute("data-busy"), "");
  assert.equal(
    frames[1].querySelector("h2")?.getAttribute("aria-hidden"),
    "true",
  );
  assert.equal(frames[1].querySelector("h2")?.textContent, "");
  assert.equal(frames[1].querySelector("h2")?.getAttribute("hidden"), null);
  assert.match(
    frames[1].querySelector(".assistant-message-body")?.textContent ?? "",
    /Live reply/,
  );
  assert.equal(document.querySelectorAll('[role="article"]').length, 4);
  assert.equal(frames[1].getAttribute("aria-busy"), null);
});

test("Code and the independent legacy Cowork renderer retain their previous wrapper branches", () => {
  assert.equal(
    transcript("code").querySelector('[data-cds="AssistantMessage"]'),
    null,
  );
  assert.equal(
    transcript("cowork", "m", false, false).querySelector(
      '[data-cds="AssistantMessage"]',
    ),
    null,
  );
  const document = parseHTML(
    renderToStaticMarkup(
      createElement(AssistantMessage, {
        bubble: true,
        busy: true,
        textSize: "sm",
        heading: "Reply",
        children: "Body",
      }),
    ),
  ).document;
  const frame = document.querySelector('[data-cds="AssistantMessage"]')!;
  assert.equal(frame.getAttribute("data-cds-bubble-stack"), "");
  assert.equal(frame.getAttribute("data-busy"), "");
  assert.equal(frame.getAttribute("data-text-size"), "sm");
});

test("a shared owner's prompt does not claim that the current viewer said it", () => {
  const { conversation } = fixture();
  conversation.sessionAuthors = {
    viewerAccountUuid: "viewer",
    ownerAccountUuid: "owner",
  };
  const document = parseHTML(
    renderToStaticMarkup(
      createElement(UserMessage, {
        conversation,
        turn: conversation.turns[0],
        busy: false,
        onEdit: async () => true,
        onRetry() {},
        onSelect() {},
      }),
    ),
  ).document;
  assert.equal(
    document.querySelector("h2.message-summary")?.textContent,
    "Hello there.",
  );
});

test("the current unbubbled frame uses the live 8px chunk gap without adding paragraph spacing", () => {
  const css = readFileSync(
    new URL("../../src/transcript/assistant-bubbles.css", import.meta.url),
    "utf8",
  );
  for (const selector of [
    ".assistant-message-frame",
    ".assistant-message-body",
  ]) {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0);
    assert.match(css.slice(at, css.indexOf("}", at)), /gap: 8px;/);
  }
  assert.doesNotMatch(
    css.slice(0, css.indexOf(".assistant-bubble-stack {")),
    /\.markdown|paragraph|margin-(top|bottom)/,
  );
});
