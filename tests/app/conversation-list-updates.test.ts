import assert from "node:assert/strict";
import test from "node:test";
import { conversationListsChanged } from "../../shared/conversation-list-updates";
import type { Conversation, Turn } from "../../shared/types";

const chat: Conversation = {
  id: "chat", mode: "chat", title: "First title", model: "fixture", providerId: "fixture",
  createdAt: 1, updatedAt: 1, pinned: false, archived: false, turns: [],
};
const turn: Turn = { id: "turn", prompt: "Question", attachments: [], items: [], status: "inProgress", createdAt: 2 };

test("list fields detect rename, star, archive, project membership, read state and sort changes", () => {
  const changed = conversationListsChanged();
  let row = { ...chat };
  assert.equal(changed({ type: "conversation", conversation: row }), true);
  for (const patch of [
    { title: "New title" }, { pinned: true }, { pinned: false },
    { archived: true }, { archived: false }, { projectId: "project" },
    { unread: true, readStateRevision: 1 }, { unread: false, readStateRevision: 2 },
    { projectId: undefined }, { updatedAt: 3 },
  ]) {
    row = { ...row, ...patch };
    assert.equal(changed({ type: "conversation", conversation: row }), true);
    assert.equal(changed({ type: "conversation", conversation: structuredClone(row) }), false);
  }
});

test("a turn start and finish refresh the lists, but same-turn streaming deltas do not", () => {
  const changed = conversationListsChanged();
  assert.equal(changed({ type: "conversation", conversation: chat }), true);
  assert.equal(changed({ type: "conversation", conversation: { ...chat, updatedAt: 2, turns: [turn] } }), true);
  for (let updatedAt = 3; updatedAt < 25; updatedAt++) {
    const streamed = { ...turn, items: [{ id: "reply", type: "agentMessage", text: "a".repeat(updatedAt) }] };
    assert.equal(changed({ type: "conversation", conversation: { ...chat, updatedAt, turns: [streamed] } }), false);
    assert.equal(changed({ type: "conversation-turn", conversationId: chat.id, turn: streamed }), false);
  }
  const completed: Conversation = { ...chat, updatedAt: 25, turns: [{ ...turn, status: "completed" }] };
  assert.equal(changed({ type: "conversation", conversation: completed }), true);
  assert.equal(changed({ type: "conversation", conversation: completed }), false);
});

test("private rows are ignored and resync clears the current list baseline", () => {
  const changed = conversationListsChanged();
  for (const row of [
    { ...chat, mode: "code" as const }, { ...chat, incognito: true },
    { ...chat, deviceChatOrigin: { version: 1 as const, accountScope: "42", logicalConversationId: "remote", active: true, permission: "default" as const } },
  ]) assert.equal(changed({ type: "conversation", conversation: row }), false);
  assert.equal(changed({ type: "conversation", conversation: chat }), true);
  assert.equal(changed({ type: "resync" }), true);
  assert.equal(changed({ type: "conversation", conversation: chat }), true);
});
