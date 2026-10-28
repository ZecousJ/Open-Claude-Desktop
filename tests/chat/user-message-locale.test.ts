import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptEdit } from "../../src/transcript/PromptEdit";
import { UserMessage } from "../../src/transcript/UserMessage";
import { CodeUserMessage } from "../../src/transcript/CodeUserMessage";
import { setLocale } from "../../src/i18n";
import type { Conversation, Turn } from "../../shared/types";

// The document translator skips .user-message, so its controls speak the
// language themselves.
before(() => setLocale("zh-CN"));
after(() => setLocale("en-US"));

const turn: Turn = {
  id: "t",
  prompt: "hello",
  attachments: [],
  items: [],
  status: "completed",
  createdAt: 1,
};
const conversation = { id: "c", turns: [turn] } as Conversation;

test("the prompt editor's controls are in the chosen language", () => {
  const html = renderToStaticMarkup(
    createElement(PromptEdit, {
      original: "hello",
      draft: "hello!",
      onDraft() {},
      busy: false,
      note: "note",
      onSave() {},
      onCancel() {},
    }),
  );
  assert.match(html, /aria-label="编辑消息"/);
  assert.match(html, /aria-label="关于保存"/);
  assert.match(html, />取消</);
  assert.match(html, />保存</);
});

test("a Chat prompt's toolbar and a Code prompt's are in the chosen language", () => {
  const chat = renderToStaticMarkup(
    createElement(UserMessage, {
      turn,
      conversation,
      busy: false,
      onEdit: async () => true,
      onRetry() {},
      onSelect() {},
    }),
  );
  assert.match(chat, /aria-label="用户消息操作"/);
  assert.match(chat, /aria-label="重试"/);
  const code = renderToStaticMarkup(
    createElement(CodeUserMessage, {
      turn,
      onEdit: async () => true,
      onRestart: () => {},
    }),
  );
  assert.match(code, /aria-label="用户消息操作"/);
  assert.match(code, /aria-label="从此处重新开始会话"/);
});
