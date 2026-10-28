import test from "node:test";
import assert from "node:assert/strict";
import {
  reorderSidebarConversations,
  sortedSidebarConversations,
} from "../../shared/conversation-order";
import type { Conversation } from "../../shared/types";

function conversation(
  id: string,
  updatedAt: number,
  pinned = false,
): Conversation {
  return {
    id,
    title: id,
    mode: "chat",
    providerId: "mock",
    model: "fixture",
    pinned,
    archived: false,
    createdAt: 1,
    updatedAt,
    turns: [],
  };
}

test("dragging a recent conversation changes its persistent order without changing recency", () => {
  const original = [
    conversation("a", 30),
    conversation("b", 20),
    conversation("c", 10),
  ];
  const moved = reorderSidebarConversations(
    original,
    "c",
    "a",
    "recent",
    "before",
  );
  assert.deepEqual(
    sortedSidebarConversations(moved).map((c) => c.id),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    moved.map((c) => c.updatedAt),
    [30, 20, 10],
  );
  assert.equal(original[2].sidebarRank, undefined);
  const newer = conversation("new", 40);
  assert.deepEqual(
    sortedSidebarConversations([...moved, newer]).map((c) => c.id),
    ["new", "c", "a", "b"],
  );
});

test("dropping into Pin moves the conversation to the top without losing other pinned order", () => {
  const rows = [
    conversation("first", 30, true),
    conversation("second", 20, true),
    conversation("recent", 10),
  ];
  const moved = reorderSidebarConversations(
    rows,
    "recent",
    undefined,
    "pinned",
    "before",
  );
  assert.deepEqual(
    sortedSidebarConversations(moved.filter((c) => c.pinned)).map((c) => c.id),
    ["recent", "first", "second"],
  );
  assert.equal(moved.find((c) => c.id === "recent")?.sidebarRank, 0);
  const unpinned = reorderSidebarConversations(
    moved,
    "first",
    undefined,
    "recent",
    "before",
  );
  assert.deepEqual(
    sortedSidebarConversations(unpinned.filter((c) => !c.pinned)).map(
      (c) => c.id,
    ),
    ["first"],
  );
});

test("invalid drag targets fail without changing stored conversations", () => {
  const rows = [conversation("a", 2), conversation("b", 1, true)];
  assert.throws(
    () =>
      reorderSidebarConversations(
        rows,
        "missing",
        undefined,
        "recent",
        "before",
      ),
    /not found/,
  );
  assert.throws(
    () => reorderSidebarConversations(rows, "a", "b", "recent", "before"),
    /not in this section/,
  );
  assert.equal(rows[0].sidebarRank, undefined);
});

test("dropping below the last row and rearranging pinned rows keeps both sections stable", () => {
  const rows = [
    conversation("a", 50, true),
    conversation("b", 40, true),
    conversation("c", 30),
    conversation("d", 20),
  ];
  const last = reorderSidebarConversations(rows, "c", "d", "recent", "after");
  assert.deepEqual(
    sortedSidebarConversations(last.filter((c) => !c.pinned)).map((c) => c.id),
    ["d", "c"],
  );
  const pinned = reorderSidebarConversations(
    last,
    "b",
    "a",
    "pinned",
    "before",
  );
  assert.deepEqual(
    sortedSidebarConversations(pinned.filter((c) => c.pinned)).map((c) => c.id),
    ["b", "a"],
  );
  assert.deepEqual(
    sortedSidebarConversations(pinned.filter((c) => !c.pinned)).map(
      (c) => c.id,
    ),
    ["d", "c"],
  );
  assert.equal(
    reorderSidebarConversations(pinned, "a", "a", "pinned", "before"),
    pinned,
  );
});
