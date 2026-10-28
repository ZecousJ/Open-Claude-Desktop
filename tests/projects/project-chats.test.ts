import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProjectChats,
  chatPreview,
  previewLimit,
  splitProjectChats,
} from "../../src/collections/projects/ProjectChats";
import type { Conversation } from "../../shared/types";

const chat = (id: string, extra: Partial<Conversation> = {}) =>
  ({
    id,
    title: id,
    mode: "chat",
    turns: [],
    updatedAt: Date.now() - 3 * 3600_000,
    createdAt: 1000,
    ...extra,
  }) as unknown as Conversation;

test("only a Cowork task shows its first message, cut at 120 characters", () => {
  const long = "x".repeat(previewLimit + 10);
  const turns = [{ prompt: `  ${long}\n` }] as Conversation["turns"];
  assert.equal(chatPreview(chat("a", { turns })), "");
  assert.equal(
    chatPreview(chat("b", { mode: "cowork", turns })),
    `${"x".repeat(previewLimit)}…`,
  );
});

test("pinned chats get their own section; archived ones stay in Recents", () => {
  const { pinned, recent } = splitProjectChats([
    chat("a", { pinned: true }),
    chat("b"),
    chat("c", { pinned: true, archived: true }),
  ]);
  assert.deepEqual(
    pinned.map((c) => c.id),
    ["a"],
  );
  assert.deepEqual(
    recent.map((c) => c.id),
    ["b", "c"],
  );
});

test("Recents shows 20 rows, then Show more, each with its time", () => {
  const chats = Array.from({ length: 25 }, (_, i) => chat(`c${i}`));
  const html = renderToStaticMarkup(
    createElement(ProjectChats, { chats, onOpen: () => {} }),
  );
  assert.equal(html.match(/class="prj-chat-row"/g)?.length, 20);
  assert.match(html, /Show more/);
  assert.match(html, /prj-chat-time/);
  assert.doesNotMatch(html, /Pinned/);
});
