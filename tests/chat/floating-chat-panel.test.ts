import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactChrome } from "../../src/artifacts/ArtifactChrome";
import { ArtifactPanel } from "../../src/artifacts/FileViewer";
import { FloatingChatPanel } from "../../src/artifacts/FloatingChatPanel";
import type { Artifact } from "../../src/ui/components";

const artifact: Artifact = {
  id: "a",
  name: "Card",
  language: "html",
  content: "<button>Test</button>",
  sourcePath: "/synthetic/card.html",
  conversationId: "one",
  surface: "artifact",
};

const chrome = (props: {
  expanded: boolean;
  chatFloating?: boolean;
  onToggleChatFloat?: () => void;
}) =>
  renderToStaticMarkup(
    createElement(ArtifactChrome, {
      artifact,
      onExpand() {},
      onClose() {},
      onRefresh() {},
      onError() {},
      ...props,
    }),
  );

test("the expanded header offers Pop out chat only with a conversation beside it (R-1047)", () => {
  const offered = chrome({ expanded: true, onToggleChatFloat() {} });
  assert.match(offered, /aria-label="Pop out chat"[^>]*aria-pressed="false"/);
  assert.match(offered, /artifact-chat-button[^]*Show chat/);
  // Expanded without a floating chat, Chat is still the only way back.
  assert.doesNotMatch(offered, /aria-label="Close"/);
  // The Artifacts page has no conversation to float.
  assert.doesNotMatch(chrome({ expanded: true }), /Pop out chat/);
  // Beside the conversation the split header never offers it.
  assert.doesNotMatch(
    chrome({ expanded: false, onToggleChatFloat() {} }),
    /Pop out chat/,
  );
});

test("while the chat floats, Pop out chat is pressed, Chat collapses and Close returns (R-1047)", () => {
  const floating = chrome({
    expanded: true,
    chatFloating: true,
    onToggleChatFloat() {},
  });
  assert.match(floating, /aria-label="Pop out chat"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(floating, /class="star"/);
  assert.match(floating, /data-icon="Collapse"[^]*Chat/);
  assert.match(floating, /aria-label="Close"/);
});

test("the floating card has Expand chat and Close chat and nothing else of its own (R-1048)", () => {
  const html = renderToStaticMarkup(
    createElement(FloatingChatPanel, { onDock() {}, onClose() {} }),
  );
  assert.match(html, /class="floating-chat-frame"/);
  assert.match(html, /aria-label="Expand chat"/);
  assert.match(html, /aria-label="Close chat"/);
  assert.doesNotMatch(html, /<textarea|<form/);
});

test("the file viewer floats nothing until it is expanded", () => {
  const html = renderToStaticMarkup(
    createElement(ArtifactPanel, {
      artifact,
      chatBeside: true,
      onClose() {},
      onError() {},
    }),
  );
  assert.match(html, /data-expanded="false"/);
  assert.doesNotMatch(html, /data-chat-float|floating-chat-frame/);
});

test("the stylesheet lifts the page's own conversation into the card, one window only", () => {
  const css = readFileSync(
    new URL("../../src/artifacts/floating-chat-panel.css", import.meta.url),
    "utf8",
  );
  // The transcript and composer are the page's, not a copy.
  assert.match(
    css,
    /\.chat-layout:has\(> \.file-viewer\[data-chat-float="true"\]\)\s*> \.chat-main\.has-conversation \{[^}]*visibility: visible;[^}]*position: absolute;[^}]*z-index: 14;/,
  );
  // 15px in, 418×482, 12px corners.
  assert.match(
    css,
    /\.floating-chat-frame \{[^}]*left: 15px;[^}]*bottom: 15px;[^}]*width: min\(418px, calc\(100% - 30px\)\);[^}]*height: min\(482px, calc\(100% - 64px\)\);[^}]*border-radius: 12px;/,
  );
  // An open header menu or Share popover is never covered by the card.
  assert.match(
    css,
    /:is\(\.artifact-chrome-menu, \.artifact-share-popover\)\s*\)\s*> \.chat-main\.has-conversation \{\s*z-index: 11;/,
  );
  const host = readFileSync(
    new URL("../../src/app/ArtifactHost.tsx", import.meta.url),
    "utf8",
  );
  assert.match(host, /chatBeside=\{chatBeside\}/);
  assert.doesNotMatch(host, /popOutConversation|openWindow/);
});
