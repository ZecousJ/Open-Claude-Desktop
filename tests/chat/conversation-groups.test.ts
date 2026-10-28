import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConversationGroupStore,
  conversationGroupsName,
  groupName,
  maxConversationGroups,
} from "../../electron/conversations/conversation-groups";
import {
  addedGroupId,
  effectiveGroupBy,
  emptyGroupsShown,
  groupRows,
  keepGroupWhileEmpty,
} from "../../src/sidebar/grouping";
import {
  filterActive,
  historyFilterEntries,
  isDefaultFilter,
} from "../../src/sidebar/HistoryFilter";
import { defaultFilter, type ListFilter } from "../../src/sidebar/listFilter";
import type { Conversation } from "../../shared/types";

function temporary(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-groups-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function row(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: id,
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    ...overrides,
  };
}

test("New group… creates a group with the conversation in it", (t) => {
  const root = temporary(t);
  let known = ["a", "b", "c"];
  const store = new ConversationGroupStore(root, () => known);
  assert.deepEqual(store.list(), { groups: [], members: {} });
  const created = store.create("  Research   notes ", "a");
  assert.equal(created.groups.length, 1);
  assert.equal(created.groups[0].name, "Research notes");
  assert.equal(created.members.a, created.groups[0].id);
  const id = created.groups[0].id;
  // Moving another conversation in, then moving one out keeps the group.
  store.move("b", id);
  const moved = store.move("a", null);
  assert.deepEqual(moved.members, { b: id });
  assert.equal(moved.groups.length, 1);
  // Names are unique regardless of case.
  assert.throws(() => store.create("research NOTES", "c"), /already exists/);
  assert.throws(() => store.create("   ", "c"), /Enter a group name/);
  assert.throws(() => store.create("x", "missing"), /not found/);
  assert.throws(() => store.move("c", "gone"), /no longer exists/);
  // Persisted with private permissions and read back by a new store.
  const file = path.join(root, conversationGroupsName);
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(new ConversationGroupStore(root, () => known).list(), moved);
  // A deleted conversation leaves its group; the group stays, empty.
  known = ["a", "c"];
  assert.deepEqual(store.list(), {
    groups: [{ id, name: "Research notes" }],
    members: {},
  });
});

test("a group stays when its last conversation leaves", (t) => {
  const store = new ConversationGroupStore(temporary(t), () => ["a", "b"]);
  const first = store.create("One", "a").groups[0].id;
  const second = store.create("Two", "b").groups[1].id;
  const after = store.move("a", second);
  assert.deepEqual(
    after.groups.map((group) => group.id),
    [first, second],
  );
  assert.deepEqual(after.members, { a: second, b: second });
  // Moving out of every group keeps it too, and the empty group can still
  // take a conversation, be renamed and be deleted.
  store.move("a", null);
  store.move("b", null);
  assert.equal(store.list().groups.length, 2);
  assert.deepEqual(store.move("a", first).members, { a: first });
  assert.equal(store.rename(second, "Renamed").groups[1].name, "Renamed");
  assert.deepEqual(store.remove(second).groups, [{ id: first, name: "One" }]);
});

test("New group… on a heading creates an empty group", (t) => {
  const root = temporary(t);
  const store = new ConversationGroupStore(root, () => ["a"]);
  const before = store.create("Filled", "a");
  const next = store.create("  Later  ");
  assert.deepEqual(
    next.groups.map((group) => group.name),
    ["Filled", "Later"],
  );
  assert.deepEqual(next.members, before.members);
  assert.equal(addedGroupId(before, next), next.groups[1].id);
  assert.equal(addedGroupId(next, next), undefined);
  // null (the web's way of leaving it out) is the same as no conversation.
  assert.equal(store.create("Third", null).groups.length, 3);
  // Read back from disk by a new store: the empty groups persist.
  assert.deepEqual(
    new ConversationGroupStore(root, () => ["a"])
      .list()
      .groups.map((group) => group.name),
    ["Filled", "Later", "Third"],
  );
  assert.throws(() => store.create("later"), /already exists/);
  assert.throws(() => store.create(" "), /Enter a group name/);
});

test("group limits and unreadable files", (t) => {
  const root = temporary(t);
  const ids = Array.from(
    { length: maxConversationGroups + 1 },
    (_, i) => `c${i}`,
  );
  const store = new ConversationGroupStore(root, () => ids);
  for (let i = 0; i < maxConversationGroups; i++) store.create(`G${i}`, ids[i]);
  assert.throws(
    () => store.create("One more", ids[maxConversationGroups]),
    /up to 50 groups/,
  );
  assert.throws(() => groupName("x".repeat(61)), /up to 60/);
  fs.writeFileSync(path.join(root, conversationGroupsName), "{broken");
  assert.throws(() => store.list(), /couldn't be read/);
  // The broken file is left alone.
  assert.equal(
    fs.readFileSync(path.join(root, conversationGroupsName), "utf8"),
    "{broken",
  );
  fs.writeFileSync(
    path.join(root, conversationGroupsName),
    JSON.stringify({ groups: [{ id: "g", name: "G" }], members: { c0: "x" } }),
  );
  assert.throws(() => store.list(), /couldn't be read/);
});

test("Group by Custom groups follows the group order with Ungrouped last", () => {
  assert.equal(effectiveGroupBy("chat", "custom"), "custom");
  assert.equal(effectiveGroupBy("code", "custom"), "custom");
  assert.equal(effectiveGroupBy("code", "type"), "none");
  const rows = [row("a"), row("b"), row("c"), row("d")];
  const groups = groupRows(rows, "custom", 0, {
    groups: [
      { id: "g2", name: "Second" },
      { id: "g1", name: "First" },
      { id: "empty", name: "Empty" },
    ],
    members: { a: "g1", c: "g2", d: "g1" },
  });
  assert.deepEqual(
    groups.map((group) => [group.label, group.rows.map((r) => r.id)]),
    [
      ["Second", ["c"]],
      ["First", ["a", "d"]],
      ["Ungrouped", ["b"]],
    ],
  );
  // An empty group is drawn only when showEmpty asks for it.
  assert.deepEqual(
    groupRows(
      rows,
      "custom",
      0,
      {
        groups: [
          { id: "g1", name: "First" },
          { id: "empty", name: "Empty" },
        ],
        members: { a: "g1" },
      },
      (id) => id === "empty",
    ).map((group) => [group.label, group.rows.length]),
    [
      ["First", 1],
      ["Empty", 0],
      ["Ungrouped", 3],
    ],
  );
  // Without groups everything is Ungrouped.
  assert.deepEqual(
    groupRows(rows, "custom").map((group) => group.label),
    ["Ungrouped"],
  );
});

test("which empty groups the sidebar shows", () => {
  const listed = new Set(["full"]);
  // Chat and Cowork show every group; a group with rows is never "empty".
  const chat = emptyGroupsShown("chat", false, listed);
  assert.equal(chat("empty"), true);
  assert.equal(chat("full"), false);
  // Code: only with Show empty groups, or while this window keeps it.
  assert.equal(emptyGroupsShown("code", false, listed)("empty"), false);
  assert.equal(emptyGroupsShown("code", true, listed)("empty"), true);
  keepGroupWhileEmpty("kept");
  assert.equal(emptyGroupsShown("code", false, listed)("kept"), true);
});

test("Code's filter menu offers Show empty groups while grouped by custom group", () => {
  const outline = (filter: ListFilter, emptyGroups = true) =>
    historyFilterEntries("code", filter, () => {}, {
      emptyGroups,
      prStatus: emptyGroups,
    }).map((entry) => ("label" in entry ? entry.label : "—"));
  const custom: ListFilter = { ...defaultFilter, groupBy: "custom" };
  assert.ok(!outline(defaultFilter).includes("Show empty groups"));
  // Grouping by custom group is a change, so Clear filters follows.
  assert.deepEqual(outline(custom).slice(-5), [
    "—",
    "Show empty groups",
    "Show PR status",
    "—",
    "Clear filters",
  ]);
  // The history page's menu, which cannot show empty groups, leaves it out,
  // and Chat never has it.
  assert.ok(!outline(custom, false).includes("Show empty groups"));
  assert.ok(
    !historyFilterEntries("chat", custom, () => {}, { emptyGroups: true }).some(
      (entry) => "label" in entry && entry.label === "Show empty groups",
    ),
  );
  let changed: ListFilter | undefined;
  const entry = historyFilterEntries(
    "code",
    custom,
    (value) => (changed = value),
    { emptyGroups: true },
  ).find((item) => "label" in item && item.label === "Show empty groups");
  assert.ok(entry && "label" in entry);
  assert.equal(entry.checked, false);
  assert.equal(entry.keepOpen, true);
  entry.onSelect!();
  assert.equal(changed?.showEmptyGroups, true);
  // On its own it neither marks the filter active nor asks for a reset.
  const shown = { ...defaultFilter, showEmptyGroups: true };
  assert.equal(filterActive(shown), false);
  assert.equal(isDefaultFilter(shown), true);
  const { showEmptyGroups: _, ...older } = defaultFilter;
  assert.equal(filterActive(older), false);
});
