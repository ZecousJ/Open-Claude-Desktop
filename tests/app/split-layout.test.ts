import test from "node:test";
import assert from "node:assert/strict";
import {
  arrowFocus,
  clampRowSplit,
  columnCount,
  columnTracks,
  columnWeights,
  defaultCell,
  focusOrder,
  leastWeight,
  maxColumnsFor,
  normalize,
  resizeColumns,
  splitMenuState,
  stepFocus,
  type PaneEntry,
  type PaneRef,
} from "../../src/split-view/split-layout";
import { loadSplit, saveSplit } from "../../src/split-view/split-storage";
import {
  belowCell,
  focusAfterClose,
  movePane,
  placePane,
  removePane,
  rightCell,
} from "../../src/split-view/split-layout";
import { canOpenBelow, canOpenRight } from "../../src/split-view/split-layout";

const session = (id: string): PaneRef => ({ kind: "session", id });
const draft = (nonce: number): PaneRef => ({ kind: "draft", nonce });
const pane = (key: string, ref: PaneRef, col: number, row: number) =>
  ({ key, ref, pos: { col, row } }) as PaneEntry;
/** "a@1:0 b@0:1": the panes' keys with their cells, for short assertions. */
const cells = (panes: readonly PaneEntry[]) =>
  panes.map((p) => `${p.key}@${p.pos.col}:${p.pos.row}`).join(" ");

test("the columns that fit follow the width, from one to five", () => {
  assert.equal(maxColumnsFor(0), 1);
  assert.equal(maxColumnsFor(359), 1);
  assert.equal(maxColumnsFor(720), 2);
  assert.equal(maxColumnsFor(1080), 3);
  assert.equal(maxColumnsFor(5000), 5);
});

test("no pane claims the primary pane's cell; columns close up; a lone bottom rises", () => {
  assert.equal(cells(normalize([pane("a", session("a"), 0, 0)])), "a@0:1");
  // The cell below the primary pane is taken: the pane that wanted the top is dropped.
  assert.equal(
    cells(
      normalize([pane("a", session("a"), 0, 1), pane("b", session("b"), 0, 0)]),
    ),
    "a@0:1",
  );
  assert.equal(cells(normalize([pane("a", session("a"), 3, 0)])), "a@1:0");
  assert.equal(cells(normalize([pane("a", session("a"), 1, 1)])), "a@1:0");
  assert.deepEqual(normalize([]), []);
});

test("a new session on the right opens a column while one fits, below needs a free bottom", () => {
  assert.equal(canOpenRight([], 1), false);
  assert.equal(canOpenRight([], 2), true);
  assert.deepEqual(rightCell([], 2), { col: 1, row: 0 });
  const one = [pane("a", session("a"), 1, 0)];
  assert.equal(canOpenRight(one, 2), false);
  assert.equal(rightCell(one, 2), null);
  // Below the primary pane, then below the pane that is focused.
  assert.equal(canOpenBelow([], 0), true);
  assert.deepEqual(belowCell([], 0), { col: 0, row: 1 });
  assert.equal(canOpenBelow(one, 1), true);
  assert.deepEqual(belowCell(one, 1), { col: 1, row: 1 });
  const stacked = [pane("a", session("a"), 0, 1)];
  assert.equal(canOpenBelow(stacked, 0), false);
  assert.equal(belowCell(stacked, 0), null);
});

test("placing a pane: a new column, the last column when full, a bottom without a top becomes the top", () => {
  const first = placePane(
    [],
    { key: "a", ref: draft(1) },
    { col: 1, row: 0 },
    3,
  )!;
  assert.equal(cells(first.panes), "a@1:0");
  assert.equal(first.focus, 1);
  assert.equal(first.columnsChanged, true);
  // Past the last column with no room left: the last column.
  const full = placePane(
    first.panes,
    { key: "b", ref: draft(2) },
    { col: 5, row: 0 },
    2,
  )!;
  assert.equal(cells(full.panes), "a@1:0 b@1:1");
  assert.equal(full.focus, 2);
  // A bottom cell in a column with no top cell becomes the top.
  const lone = placePane(
    [],
    { key: "c", ref: draft(3) },
    { col: 1, row: 1 },
    3,
  )!;
  assert.equal(cells(lone.panes), "c@1:0");
  // The primary pane's cell is the one below it.
  const under = placePane(
    [],
    { key: "d", ref: draft(4) },
    { col: 0, row: 0 },
    3,
  )!;
  assert.equal(cells(under.panes), "d@0:1");
});

test("a session opened over another pane replaces it; a draft in the way moves to a free cell", () => {
  const panes = [pane("a", session("a"), 1, 0), pane("b", session("b"), 0, 1)];
  const replaced = placePane(
    panes,
    { key: "c", ref: session("c") },
    { col: 1, row: 0 },
    2,
  )!;
  assert.deepEqual(
    replaced.panes.map((p) => p.ref),
    [session("c"), session("b")],
  );
  assert.equal(replaced.focus, 1);
  const withDraft = [pane("a", draft(1), 1, 0), pane("b", session("b"), 0, 1)];
  const moved = placePane(
    withDraft,
    { key: "c", ref: session("c") },
    { col: 1, row: 0 },
    2,
  )!;
  assert.equal(cells(moved.panes), "a@1:1 b@0:1 c@1:0");
  // Nowhere to move the draft to: nothing is placed.
  const crowded = [
    pane("a", draft(1), 1, 0),
    pane("b", session("b"), 0, 1),
    pane("d", session("d"), 1, 1),
  ];
  assert.equal(
    placePane(crowded, { key: "c", ref: session("c") }, { col: 1, row: 0 }, 2),
    null,
  );
});

test("a session with no free cell replaces the last pane that is not a draft", () => {
  const panes = [
    pane("a", session("a"), 1, 0),
    pane("b", session("b"), 0, 1),
    pane("c", draft(1), 1, 1),
  ];
  assert.deepEqual(defaultCell(panes, 2), { col: 1, row: 0 });
  assert.deepEqual(defaultCell([], 2), { col: 1, row: 0 });
  assert.deepEqual(defaultCell([pane("a", session("a"), 1, 0)], 2), {
    col: 0,
    row: 1,
  });
});

test("closing a pane closes up what is left and keeps the focus on the same pane", () => {
  const panes = [
    pane("a", session("a"), 1, 0),
    pane("b", session("b"), 1, 1),
    pane("c", session("c"), 2, 0),
  ];
  assert.equal(cells(removePane(panes, 1)), "b@1:0 c@2:0");
  assert.equal(cells(removePane(panes, 3)), "a@1:0 b@1:1");
  assert.equal(focusAfterClose(3, 1, 2), 2);
  assert.equal(focusAfterClose(1, 3, 2), 1);
  assert.equal(focusAfterClose(2, 2, 2), 2);
  assert.equal(focusAfterClose(3, 3, 2), 2);
  assert.equal(focusAfterClose(0, 1, 2), 0);
});

test("focus walks the panes column by column, top to bottom, the primary pane first", () => {
  const panes = [
    pane("a", session("a"), 2, 0),
    pane("b", session("b"), 1, 1),
    pane("c", session("c"), 1, 0),
  ];
  // Indexes are in list order: a = 1, b = 2, c = 3.
  assert.deepEqual(focusOrder(panes), [0, 3, 2, 1]);
  assert.equal(stepFocus(panes, 0, 1), 3);
  assert.equal(stepFocus(panes, 1, 1), 0);
  assert.equal(stepFocus(panes, 0, -1), 1);
  assert.equal(stepFocus(panes, 3, -1), 0);
  assert.equal(stepFocus([], 0, 1), 0);
});

test("arrows move the focus to the neighbour, falling back to the column's top", () => {
  const panes = [
    pane("a", session("a"), 1, 0),
    pane("b", session("b"), 0, 1),
    pane("c", session("c"), 2, 1),
  ];
  assert.equal(arrowFocus(panes, 0, "right"), 1);
  assert.equal(arrowFocus(panes, 0, "down"), 2);
  assert.equal(arrowFocus(panes, 0, "left"), null);
  assert.equal(arrowFocus(panes, 1, "left"), 0);
  assert.equal(arrowFocus(panes, 2, "up"), 0);
  // Nothing at the right of (1, 0)'s column beyond column 2's top.
  assert.equal(arrowFocus(panes, 1, "right"), null);
  // From the bottom of column 0 right: no pane at (1, 1), so column 1's top.
  assert.equal(arrowFocus(panes, 2, "right"), 1);
});

test("a free cell swaps or moves the focused pane; the move must change something", () => {
  const panes = [pane("a", session("a"), 1, 0), pane("b", session("b"), 1, 1)];
  // b moves up: swaps with a.
  const up = movePane(panes, 2, "up", 3, session("p"))!;
  assert.equal(cells(up.panes), "a@1:1 b@1:0");
  assert.equal(up.focus, 2);
  assert.equal(up.promoted, undefined);
  // a moves right into a new column: b rises to the old column's top.
  const right = movePane(panes, 1, "right", 3, session("p"))!;
  assert.equal(cells(right.panes), "a@2:0 b@1:0");
  assert.equal(right.columnsChanged, true);
  // …but not when the columns are full.
  assert.equal(movePane(panes, 1, "right", 2, session("p")), null);
  // Moving the only pane of a column into a free bottom cell changes nothing.
  assert.equal(
    movePane([pane("a", session("a"), 1, 0)], 1, "down", 3, session("p")),
    null,
  );
  // The lone pane of a column has no new column to go to.
  assert.equal(
    movePane([pane("a", session("a"), 1, 0)], 1, "right", 3, null),
    null,
  );
});

test("the primary pane swaps places with a pane that holds a session", () => {
  const panes = [pane("a", session("a"), 1, 0), pane("b", draft(1), 0, 1)];
  const swap = movePane(panes, 0, "right", 3, session("p"))!;
  assert.equal(swap.promoted, "a");
  assert.deepEqual(swap.panes[0].ref, session("p"));
  // The old primary session sits where the focus goes.
  assert.equal(swap.focus, 1);
  // A draft cannot become the primary pane.
  assert.equal(movePane(panes, 0, "down", 3, session("p")), null);
  // Nor can a pane swap with a primary pane that holds no session.
  assert.equal(movePane(panes, 1, "left", 3, null), null);
  // A pane moving to the primary pane's cell is promoted; the focus follows to it.
  const promote = movePane(panes, 1, "left", 3, session("p"))!;
  assert.equal(promote.promoted, "a");
  assert.equal(promote.focus, 0);
  // The primary pane has nowhere to go but onto a pane.
  assert.equal(movePane([], 0, "right", 3, session("p")), null);
});

test("the Split View menu reports what can be done", () => {
  assert.deepEqual(splitMenuState([], 0, 3, session("p")), {
    newRight: true,
    newBelow: true,
    split: false,
    moveLeft: false,
    moveRight: false,
    moveUp: false,
    moveDown: false,
  });
  const state = splitMenuState(
    [pane("a", session("a"), 1, 0)],
    1,
    2,
    session("p"),
  );
  assert.equal(state.newRight, false);
  assert.equal(state.newBelow, true);
  assert.equal(state.split, true);
  assert.equal(state.moveLeft, true);
  assert.equal(state.moveRight, false);
});

test("column widths start equal, resize in pairs and keep a least width", () => {
  assert.deepEqual(columnWeights(undefined, 3), [1, 1, 1]);
  assert.deepEqual(columnWeights([1, 2], 3), [1, 1, 1]);
  assert.deepEqual(columnWeights([2, 1], 2), [2, 1]);
  assert.equal(columnTracks([1, 2]), "minmax(0, 1fr) minmax(0, 2fr)");
  assert.deepEqual(resizeColumns([1, 1, 1], 0, 0.5, 0.25), [1.5, 0.5, 1]);
  // Never below the least width, and never past the neighbour's.
  assert.deepEqual(resizeColumns([1, 1, 1], 0, 5, 0.25), [1.75, 0.25, 1]);
  assert.deepEqual(resizeColumns([1, 1, 1], 1, -5, 0.25), [1, 0.25, 1.75]);
  assert.equal(leastWeight(1280, 4), 1);
  // Rows: the divider keeps 320px for each, or sits in the middle.
  assert.equal(clampRowSplit(0.1, 1000), 0.32);
  assert.ok(Math.abs(clampRowSplit(0.9, 1000) - 0.68) < 1e-9);
  assert.equal(clampRowSplit(0.9, 500), 0.5);
});

test("saved panes keep sessions, cells and sizes; drafts and nonsense are left out", () => {
  const panes = [
    pane("a", session("a"), 1, 0),
    pane("d", draft(1), 2, 0),
    pane("b", session("b"), 1, 1),
  ];
  const saved = saveSplit(panes, [1, 2, 1], 0.4);
  assert.deepEqual(saved.panes, [
    { key: "a", id: "a", col: 1, row: 0 },
    { key: "b", id: "b", col: 1, row: 1 },
  ]);
  // The weights were for three columns; two remain, so they start equal.
  assert.equal(saved.weights, undefined);
  assert.equal(saved.rowSplit, 0.4);
  const same = saveSplit(panes.slice(0, 1), [1, 2], 0.5);
  assert.deepEqual(same.weights, [1, 2]);
  const loaded = loadSplit(JSON.parse(JSON.stringify(same)));
  assert.equal(cells(loaded.panes), "a@1:0");
  assert.deepEqual(loaded.weights, [1, 2]);
  assert.equal(loaded.rowSplit, 0.5);
  for (const bad of [
    null,
    3,
    "x",
    {},
    { panes: "x" },
    { panes: [null, { id: 1 }] },
  ])
    assert.deepEqual(loadSplit(bad).panes, []);
  // A session twice, a cell out of range or a row that does not exist is skipped.
  const messy = loadSplit({
    panes: [
      { key: "a", id: "s", col: 1, row: 0 },
      { key: "b", id: "s", col: 2, row: 0 },
      { key: "c", id: "t", col: 9, row: 0 },
      { key: "d", id: "u", col: 1, row: 2 },
    ],
    rowSplit: 3,
  });
  assert.equal(cells(messy.panes), "a@1:0");
  assert.equal(messy.rowSplit, 0.5);
  assert.equal(columnCount(messy.panes), 2);
});
