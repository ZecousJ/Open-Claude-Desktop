import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SideChatPanel } from "../../src/side-chat/SideChatPanel";
import { inheritedMessageCount } from "../../src/side-chat/side-chat-model";
import type { Item, Turn } from "../../shared/types";
import { readSource } from "../support/read-source";

const reply: Item = { id: "m", type: "agentMessage", text: "Done." };
const turn = (id: string, items: Item[] = [reply]): Turn => ({
  id,
  prompt: id,
  attachments: [],
  items,
  status: "completed",
  createdAt: 1,
});

test("the side chat counts the prompts and replies it sees from the main chat", () => {
  assert.equal(inheritedMessageCount({ turns: [] }), 0);
  assert.equal(inheritedMessageCount({ turns: [turn("a"), turn("b")] }), 4);
  // A turn with no reply text, or one still being sent, adds only what exists.
  assert.equal(inheritedMessageCount({ turns: [turn("a", [])] }), 1);
  assert.equal(inheritedMessageCount({ turns: [turn("pending-x")] }), 0);
});

const panel = (mode: "chat" | "code", count: number) =>
  renderToStaticMarkup(
    createElement(SideChatPanel, {
      conversationId: "c",
      state: {
        open: true,
        sideChatId: "s",
        messages: [],
        thinking: false,
        draft: "",
      },
      mode,
      platform: "darwin",
      inheritedMessageCount: count,
      onClose() {},
      onBranch() {},
    }),
  );

test("Chat's side chat shows what it sees under the header, read-only", () => {
  const html = panel("chat", 4);
  assert.match(html, /Sees 4 messages from main chat/);
  assert.match(html, /read-only/);
  assert.match(panel("chat", 1), /Sees 1 message from main chat/);
  assert.doesNotMatch(panel("chat", 0), /from main chat/);
  assert.doesNotMatch(panel("code", 4), /from main chat/);
});

test("the question bubble is darker than the dark card, as in the original", () => {
  const css = readSource("src/side-chat/side-chat.css");
  assert.match(css, /\.side-chat-question p \{[^}]*background: #111;/);
  assert.match(
    css,
    /\[data-theme="light"\]\) \.side-chat \{\s*background: #20201f;/,
  );
});
