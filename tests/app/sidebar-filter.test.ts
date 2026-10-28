import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../../shared/types";
import {
  defaultFilter,
  nestSidebarRows,
  pinnedRows,
  recentRows,
} from "../../src/sidebar/listFilter";

const day = 86_400_000;
const now = 100 * day;
const row = (id: string, patch: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  mode: "chat",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: now - 10 * day,
  updatedAt: now - day,
  turns: [],
  ...patch,
});

test("each surface lists only its own conversations, pinned ones separately", () => {
  const all = [
    row("chat"),
    row("task", { mode: "cowork" }),
    row("code", { mode: "code" }),
    row("pinned-code", { mode: "code", pinned: true }),
  ];
  const ids = (rows: Conversation[]) => rows.map((c) => c.id);
  assert.deepEqual(ids(recentRows(all, "chat", defaultFilter, now)), [
    "chat",
    "task",
  ]);
  assert.deepEqual(ids(recentRows(all, "code", defaultFilter, now)), ["code"]);
  assert.deepEqual(ids(pinnedRows(all, "code")), ["pinned-code"]);
  assert.deepEqual(ids(pinnedRows(all, "cowork")), []);
});

test("type, status and last activity narrow the chat list", () => {
  const all = [
    row("recent-chat", { updatedAt: now - day / 2 }),
    row("old-task", { mode: "cowork", updatedAt: now - 20 * day }),
    row("archived", { archived: true, pinned: true }),
  ];
  const ids = (filter: Partial<typeof defaultFilter>) =>
    recentRows(all, "chat", { ...defaultFilter, ...filter }, now).map(
      (c) => c.id,
    );
  assert.deepEqual(ids({ type: "cowork" }), ["old-task"]);
  assert.deepEqual(ids({ activity: 7 }), ["recent-chat"]);
  assert.deepEqual(ids({ status: "archived" }), ["archived"]);
  assert.equal(ids({ status: "all" }).length, 3);
});

test("sort orders by name, creation or the manual activity order", () => {
  const all = [
    row("b", { createdAt: 3, updatedAt: 1 }),
    row("A", { createdAt: 1, updatedAt: 3 }),
    row("c", { createdAt: 2, updatedAt: 2, sidebarRank: 0 }),
  ];
  const ids = (sort: typeof defaultFilter.sort) =>
    recentRows(all, "chat", { ...defaultFilter, sort }, now).map((c) => c.id);
  assert.deepEqual(ids("name"), ["A", "b", "c"]);
  assert.deepEqual(ids("created"), ["b", "c", "A"]);
  // Rows without a manual rank stay above ranked ones, newest first.
  assert.deepEqual(ids("activity"), ["A", "b", "c"]);
});

test("nested sessions follow their parent; Hide nested sessions hides them", () => {
  const all = [
    row("parent", { updatedAt: 5 }),
    row("child", { parentSessionId: "parent", updatedAt: 4 }),
    row("grandchild", { parentSessionId: "child", updatedAt: 3 }),
    row("other", { updatedAt: 2 }),
  ];
  assert.deepEqual(
    nestSidebarRows(all).map((value) => value.id),
    ["parent", "child", "grandchild", "other"],
  );
  assert.deepEqual(
    nestSidebarRows(
      all.map((value) =>
        value.id === "parent"
          ? { ...value, nestedSessionsHidden: true }
          : value,
      ),
    ).map((value) => value.id),
    ["parent", "other"],
  );
  const cyclic = [
    row("a", { parentSessionId: "b" }),
    row("b", { parentSessionId: "a" }),
  ];
  assert.deepEqual(
    nestSidebarRows(cyclic)
      .map((value) => value.id)
      .sort(),
    ["a", "b"],
  );
});

test("a folded parent hides its nested sessions, even deeper ones", async () => {
  const { nestSidebarRows } = await import("../../src/sidebar/listFilter");
  const row = (id: string, extra = {}) => ({ id, ...extra }) as never;
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  assert.deepEqual(
    ids(
      nestSidebarRows([
        row("a", { nestedSessionsHidden: true }),
        row("b", { parentSessionId: "a" }),
        row("c", { parentSessionId: "b" }),
        row("d"),
      ]),
    ),
    ["a", "d"],
  );
  assert.deepEqual(
    ids(
      nestSidebarRows([
        row("x", { parentSessionId: "y" }),
        row("y", { parentSessionId: "x" }),
      ]),
    ),
    ["x", "y"],
  );
});
