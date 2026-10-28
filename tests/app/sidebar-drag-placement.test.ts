import test from "node:test";
import assert from "node:assert/strict";
import {
  dragIntent,
  dragShifts,
  groupDrop,
  landingOffset,
  sameIntent,
  slotTarget,
  type DragLayout,
} from "../../src/sidebar/dragPlacement";

// Rows 27px apart: Pinned a, b, c from y=100; Recents' label at 200, then
// rows r1 (227), r2 (254), r3 (281).
const step = 27;
const pinnedRow = (key: string, index: number) => ({
  key,
  top: 100 + index * step,
  mid: 100 + index * step + step / 2,
});
const pinned = ["a", "b", "c"].map(pinnedRow);
const below = [
  { key: "label", top: 200 },
  { key: "r1", top: 227 },
  { key: "r2", top: 254 },
  { key: "r3", top: 281 },
];
const fromRecents = (srcY: number): DragLayout => ({
  pinned,
  below,
  srcY,
  srcPinnedIndex: -1,
  pinnedBottom: 181,
  nextSectionTop: 200,
  rowStep: step,
});
const fromPinned = (index: number): DragLayout => ({
  ...fromRecents(pinned[index].top),
  srcPinnedIndex: index,
});

test("a row from below takes the slot under the pointer, reaching to the next section", () => {
  const layout = fromRecents(254);
  assert.deepEqual(dragIntent(layout, 90, null), {
    slot: 0,
    unpin: false,
    group: null,
  });
  assert.deepEqual(dragIntent(layout, 120, null), {
    slot: 1,
    unpin: false,
    group: null,
  });
  assert.deepEqual(dragIntent(layout, 170, null), {
    slot: 3,
    unpin: false,
    group: null,
  });
  // Pinned reaches down to Recents (19px gap, at most a row).
  assert.deepEqual(dragIntent(layout, 195, null), {
    slot: 3,
    unpin: false,
    group: null,
  });
  assert.deepEqual(dragIntent(layout, 205, null), {
    slot: null,
    unpin: false,
    group: null,
  });
  // Holding the last slot keeps it a row further.
  assert.deepEqual(dragIntent(layout, 205, 3), {
    slot: 3,
    unpin: false,
    group: null,
  });
  assert.deepEqual(dragIntent(layout, 230, 3), {
    slot: null,
    unpin: false,
    group: null,
  });
});

test("a pinned row unpins below Pinned and does nothing over its own place", () => {
  const layout = fromPinned(1);
  assert.deepEqual(dragIntent(layout, 181, null), {
    slot: null,
    unpin: true,
    group: null,
  });
  assert.deepEqual(dragIntent(layout, 120, null), {
    slot: null,
    unpin: false,
    group: null,
  });
  assert.deepEqual(dragIntent(layout, 150, null), {
    slot: null,
    unpin: false,
    group: null,
  });
  assert.deepEqual(dragIntent(layout, 105, null), {
    slot: 0,
    unpin: false,
    group: null,
  });
  assert.deepEqual(dragIntent(layout, 175, null), {
    slot: 3,
    unpin: false,
    group: null,
  });
});

test("rows from the slot down and everything above the dragged row slide down a row", () => {
  const shifts = dragShifts(fromRecents(254), 1);
  assert.deepEqual(
    [...shifts.entries()],
    [
      ["b", 1],
      ["c", 1],
      ["label", 1],
      ["r1", 1],
    ],
  );
  assert.equal(dragShifts(fromRecents(254), null).size, 0);
  // Into an empty section nothing slides: its "Drop here" row is the slot.
  assert.equal(dragShifts({ ...fromRecents(254), pinned: [] }, 0).size, 0);
});

test("a pinned row moving within Pinned: the rows between slide toward its place", () => {
  assert.deepEqual(
    [...dragShifts(fromPinned(2), 0).entries()],
    [
      ["a", 1],
      ["b", 1],
    ],
  );
  assert.deepEqual(
    [...dragShifts(fromPinned(0), 3).entries()],
    [
      ["b", -1],
      ["c", -1],
    ],
  );
});

test("a release shows the row where the slot is and asks for that place", () => {
  assert.equal(landingOffset(fromRecents(254), 1), 127 - 254);
  assert.equal(landingOffset(fromRecents(254), 3), 181 - 254);
  assert.equal(landingOffset(fromPinned(0), 3), 154 - 100);
  assert.equal(landingOffset(fromPinned(2), 0), 100 - 154);
  assert.equal(landingOffset({ ...fromRecents(254), pinned: [] }, 0), null);
  assert.deepEqual(slotTarget(fromRecents(254), 1), {
    targetId: "b",
    position: "before",
  });
  assert.deepEqual(slotTarget(fromRecents(254), 3), {
    targetId: "c",
    position: "after",
  });
  assert.deepEqual(slotTarget(fromPinned(0), 3), {
    targetId: "c",
    position: "after",
  });
  assert.deepEqual(slotTarget(fromPinned(2), 0), {
    targetId: "a",
    position: "before",
  });
  assert.deepEqual(slotTarget({ ...fromRecents(254), pinned: [] }, 0), {
    position: "before",
  });
});

test("over a custom group a release moves the row there; its own group does nothing", () => {
  const zones = [
    { id: "g1", label: "Work", top: 300, bottom: 360 },
    { id: "g2", label: "Home", top: 368, bottom: 430 },
    { id: null, label: "Ungrouped", top: 438, bottom: 520 },
  ];
  const fromWork = { zone: 0, pinned: false };
  // Outside every zone the pin logic decides.
  assert.equal(groupDrop(zones, 290, fromWork), undefined);
  assert.equal(groupDrop(zones, 364, fromWork), undefined);
  // Its own group: no move (custom groups keep no order).
  assert.equal(groupDrop(zones, 320, fromWork), null);
  assert.deepEqual(groupDrop(zones, 368, fromWork), {
    id: "g2",
    label: "Home",
  });
  // Ungrouped takes a grouped row out of its group.
  assert.deepEqual(groupDrop(zones, 500, fromWork), {
    id: null,
    label: "Ungrouped",
  });
  // A pinned row moves into a group, and over Ungrouped it unpins instead.
  const pinned = { zone: -1, pinned: true };
  assert.deepEqual(groupDrop(zones, 330, pinned), { id: "g1", label: "Work" });
  assert.equal(groupDrop(zones, 500, pinned), undefined);
});

test("intents are the same only when slot, unpin and group agree", () => {
  const none = { slot: null, unpin: false, group: null };
  assert.equal(sameIntent(none, { ...none }), true);
  assert.equal(
    sameIntent(none, { ...none, group: { id: null, label: "Ungrouped" } }),
    false,
  );
  assert.equal(
    sameIntent(
      { ...none, group: { id: "a", label: "A" } },
      { ...none, group: { id: "b", label: "B" } },
    ),
    false,
  );
  assert.equal(sameIntent(none, { ...none, unpin: true }), false);
});
