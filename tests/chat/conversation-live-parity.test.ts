import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Conversation, Mode, Turn } from "../../shared/types";
import { ConversationTitle } from "../../src/conversation/ConversationTitle";
import { ConversationTranscript } from "../../src/transcript/ConversationTranscript";
import { AppContext } from "../../src/app/AppContext";
import { ConversationSurface } from "../../src/mobile-conversation/ConversationSurface";
import { ConversationBridge } from "../../src/mobile-conversation/bridge";
import type { ConversationRenderState } from "../../shared/mobile/conversation-contract";

const turn = (id: string, extra: Partial<Turn> = {}): Turn => ({
  id,
  prompt: `Prompt ${id}`,
  attachments: [],
  createdAt: 1,
  status: "completed",
  items: [{ id: `${id}-reply`, type: "agentMessage", text: `Reply ${id}` }],
  ...extra,
});
const conversation = (turns: Turn[], mode: Mode = "chat"): Conversation => ({
  id: "live-parity",
  title: "Settings",
  mode,
  providerId: "fixture",
  model: "Opus 5.5",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns,
});
const noop = () => {};

function transcript(value: Conversation, size?: "s" | "m" | "l") {
  const html = renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      {
        value: { snapshot: { settings: { transcriptTextSize: size } } } as any,
      },
      createElement(ConversationTranscript, {
        conversation: value,
        mode: value.mode,
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
        away: true,
        onJumpToLatest: noop,
      }),
    ),
  );
  return parseHTML(html).document;
}

test("Chat numbers the prompt and reply separately across multiple turns", () => {
  const document = transcript(conversation([turn("one"), turn("two")]));
  const feed = document.querySelector('[role="feed"]');
  assert.equal(feed?.getAttribute("aria-label"), "Chat messages");
  const messages = [...feed!.querySelectorAll('[role="article"]')];
  assert.deepEqual(
    messages.map((message) => message.getAttribute("aria-label")),
    ["Message 1 of 4", "Message 2 of 4", "Message 3 of 4", "Message 4 of 4"],
  );
  assert.deepEqual(
    messages.map((message) => message.getAttribute("aria-posinset")),
    ["1", "2", "3", "4"],
  );
  for (const message of messages) {
    assert.equal(message.getAttribute("aria-setsize"), "4");
    assert.equal(message.getAttribute("tabindex"), "-1");
  }
  assert.ok(messages[0].querySelector(".user-message"));
  assert.equal(messages[0].querySelector(".assistant-message"), null);
  assert.ok(messages[1].classList.contains("assistant-message"));
  assert.ok(messages[1].querySelector(".assistant-content"));
  assert.equal(messages[1].querySelector(".user-message"), null);
  assert.ok(document.querySelector(".scroll-bottom-button[data-round]"));
});

test("an unsent prompt has no numbered assistant response", () => {
  const document = transcript(
    conversation([
      turn("failed", { status: "failed", sendFailed: true, items: [] }),
    ]),
  );
  const messages = [...document.querySelectorAll('[role="article"]')];
  assert.equal(messages.length, 1);
  assert.equal(messages[0].getAttribute("aria-label"), "Message 1 of 1");
  assert.match(messages[0].textContent!, /Failed to send/);
});

test("feed wrappers preserve selected message sizes and Code's transcript structure", () => {
  for (const [size, expected] of [
    ["s", "sm"],
    ["l", "lg"],
  ] as const) {
    const document = transcript(conversation([turn("one")]), size);
    assert.equal(
      document
        .querySelector('.assistant-message[role="article"]')
        ?.getAttribute("data-text-size"),
      expected,
    );
    assert.equal(
      document.querySelector(".user-message")?.getAttribute("data-text-size"),
      expected,
    );
  }
  const document = transcript(conversation([turn("one")], "code"));
  assert.equal(document.querySelector('[role="feed"]'), null);
  assert.equal(document.querySelector('[role="article"]'), null);
  assert.ok(document.querySelector('.messages-scroll[role="region"]'));
  assert.ok(document.querySelector(".messages > .turn > .user-message"));
  assert.equal(
    document.querySelector(".scroll-bottom-button[data-round]"),
    null,
  );
});

test("Chat has separate rename and menu controls; Code retains its combined menu", () => {
  const actions = {
    onPin: noop,
    onRename: noop,
    onMoveToProject: noop,
    onCreateProject: noop,
    onOpenProjects: noop,
    onArchive: noop,
    onDelete: noop,
  };
  const render = (mode: Mode) =>
    parseHTML(
      renderToStaticMarkup(
        createElement(ConversationTitle, {
          conversation: conversation([], mode),
          projects: [],
          running: false,
          actions,
        }),
      ),
    ).document;
  const chat = render("chat");
  const rename = chat.querySelector(".thread-rename-trigger");
  assert.equal(rename?.getAttribute("aria-label"), "Settings, rename session");
  assert.equal(rename?.getAttribute("aria-haspopup"), null);
  assert.equal(rename?.textContent, "Settings");
  assert.ok(rename?.querySelector("[data-no-translate]"));
  const menu = chat.querySelector(".thread-menu-trigger");
  assert.equal(menu?.getAttribute("aria-label"), "More options for Settings");
  assert.equal(menu?.getAttribute("aria-haspopup"), "menu");
  assert.equal(menu?.getAttribute("aria-expanded"), "false");
  const code = render("code");
  assert.equal(code.querySelector(".thread-title-split"), null);
  assert.equal(
    code.querySelector(".thread-title")?.getAttribute("aria-haspopup"),
    "menu",
  );
});

test("web feed and idle-star overrides match the browser SSR but exclude the actual native wrapper", () => {
  const styles = readFileSync(
    new URL("../../src/live-web/transcript.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(styles, /\.response-stream-mark\s*\{\s*display: none/);
  const value = conversation([turn("done")]);
  const bridge = new ConversationBridge(noop);
  const state: ConversationRenderState = {
    version: 1,
    sessionId: "native-css-scope",
    revision: 1,
    theme: "dark",
    conversation: value,
  };
  bridge.setSession(state.sessionId);
  const nativeMarkup = renderToStaticMarkup(
    createElement(ConversationSurface, { state, bridge, onApplied: noop }),
  );
  const native = parseHTML(
    `<html data-surface="web"><body>${nativeMarkup}</body></html>`,
  ).document;
  assert.ok(native.querySelector(".app.web.mobile-conversation.mode-chat"));
  for (const selector of [".messages", ".message-feed", ".response-end-mark"])
    assert.ok(native.querySelector(selector), `native SSR has ${selector}`);

  const browser = parseHTML(
    `<html data-surface="web"><body><div class="app web mode-chat">${transcript(value).toString()}</div></body></html>`,
  ).document;
  // Extract and actually match every new override against rendered markup.
  // Removing the exclusion must fail even though native SSR retains its star.
  const rules = [
    ...styles
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].filter(
    ([, selector]) =>
      selector.includes(".app.web.mode-chat") &&
      /\.(messages|message-feed|response-end-mark)\s*$/.test(selector.trim()),
  );
  assert.equal(rules.length, 3);
  const declarations = {
    messages: /padding-top:\s*12px;/,
    "message-feed": /padding-top:\s*24px;/,
    "response-end-mark": /display:\s*none;/,
  };
  for (const [, selector, body] of rules) {
    const query = selector.trim();
    assert.match(query, /:not\(\.mobile-conversation\)/);
    const target = /\.(messages|message-feed|response-end-mark)\s*$/.exec(
      query,
    )![1] as keyof typeof declarations;
    assert.match(body, declarations[target]);
    assert.ok(browser.querySelector(query), `browser matches ${query}`);
    assert.equal(native.querySelector(query), null, `native excludes ${query}`);
  }
  bridge.dispose();
});
