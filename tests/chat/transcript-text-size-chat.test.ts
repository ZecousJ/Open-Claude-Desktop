/**
 * Settings → Transcript text size in Chat and Cowork: their prompts and replies
 * carry data-text-size as Code's do, the stylesheets size each choice, the
 * Chat/Cowork composer steps its type, and a Markdown document's headings are
 * in em.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTranscript } from "../../src/transcript/ConversationTranscript";
import { AppContext } from "../../src/app/AppContext";
import { UserMessage } from "../../src/transcript/UserMessage";
import type { Conversation, Mode, Turn } from "../../shared/types";
import { readSource } from "../support/read-source";

const css = (file: string) =>
  readSource(new URL(`../../src/${file}`, import.meta.url), "utf8");

const turn = {
  id: "t",
  prompt: "Hello",
  attachments: [],
  createdAt: 1000,
  status: "completed",
  items: [{ id: "t-m", type: "agentMessage", text: "Done." }],
} as unknown as Turn;

const conversation = (mode: Mode): Conversation => ({
  id: "c",
  title: "Sizes",
  mode,
  cwd: mode === "code" ? "/r" : undefined,
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [turn],
});

function render(mode: Mode, transcriptTextSize?: "s" | "m" | "l") {
  const app = { snapshot: { settings: { transcriptTextSize } } };
  return renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      { value: app as any },
      createElement(ConversationTranscript, {
        conversation: conversation(mode),
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
      } as any),
    ),
  );
}

test("reply headings and block flow use the official Prose em scale", () => {
  const styles = css("live-web/transcript.css");
  const heading = (name: string) => {
    const start = styles.indexOf(`.mode-chat .markdown ${name} {`);
    assert.ok(start >= 0);
    return styles.slice(start, styles.indexOf("}", start));
  };
  for (const [name, size, leading, space] of [
    ["h1", "1.75em", "1.25", "3"],
    ["h2", "1.375em", "1.25", "2.5"],
    ["h3", "1.125em", "1.3", "2"],
    [":is(h4, h5, h6)", "0.875em", "1.3", "1.667"],
  ]) {
    assert.ok(heading(name).includes(`font-size: ${size};`));
    assert.ok(heading(name).includes(`line-height: ${leading};`));
    assert.ok(heading(name).includes(`--reply-heading-space: ${space};`));
    assert.ok(heading(name).includes("font-weight: 600;"));
  }
  assert.ok(heading("h4").includes("font-size: 1em;"));
  assert.match(styles, /--reply-flow: 0\.75em/);
  assert.match(styles, /\.markdown\.markdown\s+:where\(/);
  assert.match(styles, /data-prose-spacing="lg"[^}]*--reply-flow: 1em/);
  assert.match(styles, /margin-top: calc\(var\(--reply-flow\) \* 0\.667\)/);
  assert.match(styles, /margin-top: calc\(var\(--reply-flow\) \* 0\.333\)/);
  assert.match(
    styles,
    /margin-top: calc\(var\(--reply-flow\) \* var\(--reply-heading-space\)\)/,
  );
  assert.match(
    styles,
    /max\(var\(--reply-break\), var\(--reply-heading-space\)\)/,
  );
});

test("a Chat prompt carries the message size, Medium none", () => {
  const html = (textSize?: "sm" | "lg") =>
    renderToStaticMarkup(
      createElement(UserMessage, {
        conversation: conversation("chat"),
        turn,
        busy: false,
        onEdit: async () => true,
        onRetry() {},
        onSelect() {},
        textSize,
      }),
    );
  assert.match(html("sm"), /class="user-message[^"]*" data-text-size="sm"/);
  assert.match(html("lg"), /data-text-size="lg"/);
  assert.doesNotMatch(html(), /data-text-size/);
});

test("Chat and Cowork prompts and replies follow the setting", () => {
  for (const mode of ["chat", "cowork"] as const) {
    const large = render(mode, "l");
    assert.match(large, /class="user-message[^"]*" data-text-size="lg"/, mode);
    assert.match(large, /class="assistant-message" data-text-size="lg"/, mode);
    assert.match(render(mode, "s"), /data-text-size="sm"/, mode);
    assert.doesNotMatch(render(mode, "m"), /data-text-size/, mode);
    assert.doesNotMatch(render(mode), /data-text-size/, mode);
  }
});

test("the stylesheets size Chat and Cowork messages at each choice", () => {
  const sizes = css("transcript/transcript-text-size.css");
  const block = (selector: string, from = 0) => {
    const at = sizes.indexOf(`${selector} {`, from);
    assert.ok(at >= 0, selector);
    return sizes.slice(at, sizes.indexOf("}", at));
  };
  // The comfortable density's prose (reply) and small prose (bubble).
  const chatAt = sizes.indexOf("Chat and Cowork follow");
  assert.ok(chatAt > 0);
  const small = block('[data-text-size="sm"]', chatAt);
  assert.match(small, /--reply-text: 15px;\s*--reply-line: 22px;/);
  assert.match(small, /--bubble-text: 14px;\s*--bubble-line: 20px;/);
  const large = block('[data-text-size="lg"]', chatAt);
  assert.match(large, /--reply-text: 18px;\s*--reply-line: 27px;/);
  assert.match(large, /--bubble-text: 16px;\s*--bubble-line: 24px;/);
  assert.match(
    sizes,
    /:is\(\.mode-chat, \.mode-cowork\) \.assistant-message\[data-text-size\] \.markdown \{\s*font-size: var\(--reply-text\);\s*line-height: var\(--reply-line\);/,
  );
  assert.match(
    sizes,
    /\.mode-chat \.assistant-message\[data-text-size\] \.markdown h1 \{\s*font-size: 1\.75em;/,
  );
  assert.match(
    sizes,
    /\.mode-cowork\s*:is\(\s*\.user-message\[data-text-size\][^{]*\{\s*font-size: var\(--message-text\);/,
  );
  // The composer: 15/21 at Medium, a pixel either way, lines 1.4 times.
  const composerAt = sizes.indexOf("--composer-text: 15px;");
  assert.ok(composerAt > 0);
  assert.match(
    block(':root[data-chat-text-size="s"]', composerAt),
    /--composer-text: 14px;\s*--composer-line: 20px;/,
  );
  assert.match(
    block(':root[data-chat-text-size="l"]', composerAt),
    /--composer-text: 16px;\s*--composer-line: 22px;/,
  );
  assert.match(
    css("live-web/composer.css"),
    /\.composer-wrap:not\(\.code-composer\) \.composer-input-row textarea \{[^}]*font-size: var\(--composer-text, 15px\);\s*line-height: var\(--composer-line, 21px\);/,
  );
  // Tool rows take the transcript's row size.
  assert.match(
    css("transcript/chat-transcript.css"),
    /\.command-activity > summary \{[^}]*font-size: var\(--transcript-text, 14px\);\s*line-height: var\(--transcript-line, 20px\);/,
  );
});

test("a Markdown document's headings are sized in em of its text", () => {
  const panel = css("artifacts/file-viewer-panel.css");
  const heading = (tag: string) =>
    panel.match(
      new RegExp(
        `\\.is-document \\.markdown-document-column > \\.markdown ${tag} \\{([^}]*)\\}`,
      ),
    )?.[1] ?? "";
  assert.match(heading("h1"), /font-size: 1\.75em;/);
  assert.match(heading("h1"), /line-height: 1\.15;/);
  assert.match(heading("h2"), /font-size: 1\.35em;/);
  assert.match(heading("h3"), /font-size: 1\.125em;/);
  assert.match(heading("h4"), /font-size: 1em;/);
  assert.match(heading("table"), /font-size: 0\.9375em;/);
});

test("inline code: Chat's live 0.9rem (14.4px), Code 0.9 of its text (12.6px of 14px)", () => {
  const live = css("live-web/transcript.css");
  assert.match(
    live,
    /\.mode-code \.markdown\.markdown :not\(pre\) > code,\s*\.mode-code \.user-message-text\.user-message-text code \{[\s\S]*?font-size: 0\.9em;/,
  );
  assert.match(
    live,
    /\.markdown\.markdown :not\(pre\) > code,\s*\.user-message-text\.user-message-text code \{\s*(?:\/\*[\s\S]*?\*\/\s*)?font-size: 14\.4px;\s*padding: 1px 4px;/,
  );
  assert.doesNotMatch(
    css("transcript/transcript-text-size.css"),
    /:not\(pre\) > code/,
  );
});
