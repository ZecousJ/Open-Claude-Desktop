import test from "node:test";
import assert from "node:assert/strict";
import {
  clearForMenu,
  clearUnlessModified,
  selection,
} from "../../src/sidebar/multi-select";
import { bulkEntries } from "../../src/sidebar/BulkRowMenu";
import type { Conversation } from "../../shared/types";

const keys = () => [...selection.get().keys].sort();
const order = ["a", "b", "c", "d", "e"];

test("⌘-click toggles, Shift-click selects from the anchor", () => {
  selection.clear();
  selection.toggle("b", "recent");
  selection.toggle("d", "recent");
  assert.deepEqual(keys(), ["b", "d"]);
  selection.toggle("d", "recent");
  assert.deepEqual(keys(), ["b"]);
  selection.selectRange("e", order, "recent");
  assert.deepEqual(keys(), ["d", "e"]);
});

test("a selection stays in one section", () => {
  selection.clear();
  selection.toggle("a", "recent");
  selection.toggle("x", "pinned");
  assert.deepEqual(keys(), ["x"]);
  selection.selectRange("c", order, "recent");
  assert.deepEqual(keys(), ["c"]);
});

test("a plain click and a menu off the selection clear it", () => {
  selection.clear();
  selection.toggle("a");
  selection.toggle("b");
  clearUnlessModified({ metaKey: true, ctrlKey: false, shiftKey: false });
  assert.equal(selection.get().keys.size, 2);
  clearForMenu("a");
  assert.equal(selection.get().keys.size, 2);
  clearForMenu("z");
  assert.equal(selection.get().keys.size, 0);
  selection.toggle("a");
  clearUnlessModified({ metaKey: false, ctrlKey: false, shiftKey: false });
  assert.equal(selection.get().keys.size, 0);
});

test("prune drops rows that are gone", () => {
  selection.clear();
  selection.toggle("a");
  selection.toggle("b");
  selection.prune(["a"]);
  assert.deepEqual(keys(), ["b"]);
});

test("the menu over a selection runs on the rows that need it", () => {
  const rows = [
    { id: "a", pinned: true, unread: false },
    { id: "b", pinned: false, unread: false },
  ] as Conversation[];
  const pinned: string[] = [];
  const deleted: string[][] = [];
  const entries = bulkEntries(
    rows,
    {
      onTogglePin: (c) => pinned.push(c.id),
      onToggleUnread: () => {},
      onToggleArchive: () => {},
      onDeleteMany: (ids) => deleted.push(ids),
    },
    () => {},
  );
  const labels = entries.map((e) => ("label" in e ? e.label : "—"));
  // Each action counts the rows it runs on; a mixed selection offers both Pin
  // and Unpin.
  assert.deepEqual(labels, [
    "Pin 1",
    "Unpin 1",
    "Mark 2 as unread",
    "Archive 2",
    "—",
    "Delete 2",
  ]);
  (entries[0] as { onSelect: () => void }).onSelect();
  assert.deepEqual(pinned, ["b"]);
  (entries[5] as { onSelect: () => void }).onSelect();
  assert.deepEqual(deleted, [["a", "b"]]);
});

test("Move {count} to group checks the group they share and offers Ungrouped", () => {
  const rows = [{ id: "a" }, { id: "b" }] as Conversation[];
  const moved: (string | null)[] = [];
  const entries = bulkEntries(
    rows,
    {
      onTogglePin: () => {},
      onToggleUnread: () => {},
      onToggleArchive: () => {},
    },
    () => {},
    {
      list: [
        { id: "g1", name: "Work" },
        { id: "g2", name: "Home" },
      ],
      members: { a: "g1", b: "g1" },
      moveTo: (_rows, target) => moved.push(target),
    },
  );
  const group = entries[2] as {
    label: string;
    submenu: { label?: string; checked?: boolean; onSelect?: () => void }[];
  };
  assert.equal(group.label, "Move 2 to group");
  assert.deepEqual(
    group.submenu.map((e) => e.label ?? "—"),
    ["Work", "Home", "—", "Ungrouped"],
  );
  assert.equal(group.submenu[0].checked, true);
  group.submenu[3].onSelect!();
  assert.deepEqual(moved, [null]);
});
