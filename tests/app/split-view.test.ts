import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  closeFocused,
  closePane,
  dropSession,
  moveFocused,
  moveFocusToward,
  openDraft,
  openInSplit,
  resetToDraft,
  resolveDraft,
  retarget,
  setFocus,
  setMaxColumns,
  stepFocusBy,
  swapWithPrimary,
} from "../../src/split-view/split-actions";
import { splitKeyCommand } from "../../src/split-view/split-keys";
import { fitColumns, type PaneEntry } from "../../src/split-view/split-layout";
import {
  loadSplitFor,
  resetSplitState,
  setSplitState,
  splitSessionIds,
  splitState,
} from "../../src/split-view/split-state";

/** A browser storage for the tests, since Node has none. */
class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  configurable: true,
});

const ids = () =>
  splitState().panes.map((p) =>
    p.ref.kind === "session" ? p.ref.id : `draft${p.ref.nonce}`,
  );
const cells = () => splitState().panes.map((p) => `${p.pos.col}:${p.pos.row}`);

beforeEach(() => {
  resetSplitState();
  storage.removeItem("claudex.splitView.v1.me");
  loadSplitFor("me");
  setSplitState({ maxColumns: 3 });
});

test("the keys: Ctrl+] and Ctrl+[ everywhere, Control with Command or Alt for the rest", () => {
  const press = (extra: Partial<Parameters<typeof splitKeyCommand>[0]>) => ({
    key: "",
    metaKey: false,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    ...extra,
  });
  for (const mac of [true, false]) {
    assert.equal(
      splitKeyCommand(press({ key: "]", code: "BracketRight" }), mac),
      "split-focus-next",
    );
    assert.equal(
      splitKeyCommand(press({ key: "[", code: "BracketLeft" }), mac),
      "split-focus-previous",
    );
    // Control alone, without the key, is nothing.
    assert.equal(
      splitKeyCommand(press({ key: "a", code: "KeyA" }), mac),
      undefined,
    );
    // Shift turns them into other shortcuts.
    assert.equal(
      splitKeyCommand(
        press({ key: "]", code: "BracketRight", shiftKey: true }),
        mac,
      ),
      undefined,
    );
  }
  const mac = (code: string) =>
    splitKeyCommand(press({ key: "x", code, metaKey: true }), true);
  assert.equal(mac("Backslash"), "split-new-right");
  assert.equal(mac("Minus"), "split-new-below");
  assert.equal(mac("KeyW"), "split-close");
  assert.equal(mac("ArrowLeft"), "split-focus-left");
  assert.equal(mac("ArrowDown"), "split-focus-down");
  const other = (code: string, extra = {}) =>
    splitKeyCommand(press({ key: "x", code, altKey: true, ...extra }), false);
  assert.equal(other("Backslash"), "split-new-right");
  assert.equal(other("Minus"), "split-new-below");
  assert.equal(other("KeyW"), "split-close");
  assert.equal(other("ArrowRight"), "split-focus-right");
  // Alt with Command, or Command on Windows, is not the chord; nor is AltGraph.
  assert.equal(
    splitKeyCommand(
      press({ key: "x", code: "Backslash", metaKey: true, altKey: true }),
      true,
    ),
    undefined,
  );
  assert.equal(
    splitKeyCommand(
      press({ key: "x", code: "Backslash", metaKey: true }),
      false,
    ),
    undefined,
  );
  assert.equal(other("Backslash", { altGraph: true }), undefined);
  assert.equal(
    splitKeyCommand(
      press({ key: "x", code: "KeyW", ctrlKey: false, metaKey: true }),
      true,
    ),
    undefined,
  );
});

test("opening a session: beside the primary pane, then below, and a repeat only focuses", () => {
  assert.equal(openInSplit("b", "a"), 1);
  assert.deepEqual(ids(), ["b"]);
  assert.deepEqual(cells(), ["1:0"]);
  assert.equal(splitState().focus, 1);
  // The same session again, and the primary pane's own, move the focus only.
  setFocus(0);
  assert.equal(openInSplit("b", "a"), 1);
  assert.equal(splitState().focus, 1);
  assert.equal(openInSplit("a", "a"), 0);
  assert.equal(splitState().focus, 0);
  assert.deepEqual(ids(), ["b"]);
  // More fill the columns, then the bottom cells.
  openInSplit("c", "a");
  openInSplit("d", "a");
  assert.deepEqual(cells(), ["1:0", "2:0", "0:1"]);
});

test("new sessions on the right and below need room", () => {
  assert.equal(openDraft("right"), 1);
  assert.equal(openDraft("right"), 2);
  assert.equal(splitState().maxColumns, 3);
  // Three columns: no room on the right any more.
  assert.equal(openDraft("right"), null);
  setFocus(1);
  assert.equal(openDraft("below"), 3);
  assert.deepEqual(cells(), ["1:0", "2:0", "1:1"]);
  // Below the focused pane's column again: taken.
  assert.equal(openDraft("below"), null);
  // The drafts are numbered.
  assert.deepEqual(ids(), ["draft1", "draft2", "draft3"]);
});

test("a draft's first message makes it the session; the pane keeps its place", () => {
  openDraft("right");
  const key = splitState().panes[0].key;
  resolveDraft(key, "s1");
  assert.deepEqual(ids(), ["s1"]);
  assert.equal(splitState().panes[0].key, key);
  retarget(key, "s2");
  assert.deepEqual(ids(), ["s2"]);
  resetToDraft(key);
  assert.equal(splitState().panes[0].ref.kind, "draft");
  assert.deepEqual(cells(), ["1:0"]);
});

test("focus steps through the panes in reading order and by arrows", () => {
  openInSplit("b", "a");
  openInSplit("c", "a");
  openInSplit("d", "a");
  // Primary, (0,1) d, then b and c.
  setFocus(0);
  assert.equal(stepFocusBy(1), 3);
  assert.equal(stepFocusBy(1), 1);
  assert.equal(stepFocusBy(1), 2);
  assert.equal(stepFocusBy(1), 0);
  assert.equal(stepFocusBy(-1), 2);
  assert.equal(moveFocusToward("left"), 1);
  assert.equal(moveFocusToward("left"), 0);
  assert.equal(moveFocusToward("left"), null);
  assert.equal(moveFocusToward("down"), 3);
  assert.equal(moveFocusToward("up"), 0);
});

test("closing the focused pane returns to fewer panes, and to one view", () => {
  openInSplit("b", "a");
  openInSplit("c", "a");
  setFocus(1);
  assert.deepEqual(closeFocused(), {});
  assert.deepEqual(ids(), ["c"]);
  // The pane that was after it keeps the focus place.
  assert.equal(splitState().focus, 1);
  assert.deepEqual(cells(), ["1:0"]);
  closePane(splitState().panes[0].key);
  assert.deepEqual(ids(), []);
  assert.equal(splitState().focus, 0);
  // Nothing to close.
  assert.deepEqual(closeFocused(), {});
});

test("closing the primary pane promotes the first pane that holds a session", () => {
  openDraft("right");
  openInSplit("c", "a");
  openInSplit("d", "a");
  setFocus(0);
  // d sits below the primary pane, first in reading order; the draft after
  // it cannot become the primary pane anyway.
  const closed = closeFocused();
  assert.equal(closed.promote, "d");
  assert.deepEqual(ids(), ["draft1", "c"]);
  assert.equal(splitState().focus, 0);
  // Only drafts left: the primary pane becomes a new session instead.
  closePane(splitState().panes[1].key);
  assert.deepEqual(ids(), ["draft1"]);
  assert.deepEqual(closeFocused(), { newSession: true });
});

test("moving a pane swaps cells, or trades with the primary pane", () => {
  openInSplit("b", "a");
  openInSplit("c", "a");
  setFocus(1);
  // b is at (1,0), c at (2,0): moving right swaps them.
  assert.deepEqual(moveFocused("right", "a"), { promoted: undefined });
  assert.deepEqual(ids(), ["b", "c"]);
  assert.deepEqual(cells(), ["2:0", "1:0"]);
  assert.equal(splitState().focus, 1);
  // The pane in the first column trades with the primary pane going left.
  setFocus(2);
  const traded = moveFocused("left", "a");
  assert.equal(traded?.promoted, "c");
  assert.deepEqual(ids(), ["b", "a"]);
  assert.equal(splitState().focus, 0);
  // Nothing to the left of the primary pane.
  assert.equal(moveFocused("left", "a"), null);
});

test("a session the primary pane opens trades places with the pane that showed it", () => {
  openInSplit("b", "a");
  openInSplit("c", "a");
  swapWithPrimary("b", "a");
  assert.deepEqual(ids(), ["a", "c"]);
  // The primary pane was not a session: the pane goes.
  swapWithPrimary("c", undefined);
  assert.deepEqual(ids(), ["a"]);
  // Its place is already a pane: just closed.
  openInSplit("b", "a");
  swapWithPrimary("b", "a");
  assert.deepEqual(ids(), ["a"]);
  // Nothing happens for a session no pane shows.
  swapWithPrimary("zzz", "a");
  assert.deepEqual(ids(), ["a"]);
});

test("a session that is gone leaves its pane", () => {
  openInSplit("b", "a");
  openInSplit("c", "a");
  dropSession("b");
  assert.deepEqual(ids(), ["c"]);
  dropSession("nope");
  assert.deepEqual(ids(), ["c"]);
});

test("a narrow window parks the panes that do not fit, and brings them back", () => {
  openInSplit("b", "a");
  openInSplit("c", "a");
  setFocus(2);
  setMaxColumns(2);
  assert.deepEqual(ids(), ["b"]);
  assert.deepEqual(
    splitState().parked.map((p) => p.ref.kind === "session" && p.ref.id),
    ["c"],
  );
  // The pane that had the focus is parked: the primary pane has it now.
  assert.equal(splitState().focus, 0);
  // Opening more while narrow does not lose the parked one.
  setMaxColumns(3);
  assert.deepEqual(ids(), ["b", "c"]);
  assert.deepEqual(splitState().parked, []);
  assert.deepEqual(cells(), ["1:0", "2:0"]);
  // Sizes start equal again when the columns change.
  assert.equal(splitState().weights, undefined);
});

test("fitting keeps a parked column's panes together", () => {
  const entry = (key: string, col: number, row: number): PaneEntry => ({
    key,
    ref: { kind: "session", id: key },
    pos: { col, row },
  });
  const fitted = fitColumns(
    [entry("a", 1, 0), entry("b", 2, 0), entry("c", 2, 1)],
    [],
    2,
  );
  assert.deepEqual(
    fitted.panes.map((p) => p.key),
    ["a"],
  );
  assert.deepEqual(
    fitted.parked.map((p) => p.key),
    ["b", "c"],
  );
  const back = fitColumns(fitted.panes, fitted.parked, 3);
  assert.deepEqual(
    back.panes.map((p) => `${p.key}@${p.pos.col}:${p.pos.row}`).sort(),
    ["a@1:0", "b@2:0", "c@2:1"],
  );
  assert.deepEqual(back.parked, []);
  // No room yet: still parked, and no pane replaced.
  const still = fitColumns(fitted.panes, fitted.parked, 2);
  assert.deepEqual(
    still.parked.map((p) => p.key),
    ["b", "c"],
  );
});

test("the panes with sessions are remembered for the account, drafts are not", () => {
  openInSplit("b", "a");
  openDraft("right");
  openInSplit("c", "a");
  const saved = JSON.parse(storage.getItem("claudex.splitView.v1.me")!);
  assert.deepEqual(
    saved.panes.map((p: { id: string }) => p.id),
    ["b", "c"],
  );
  // A new launch reads them back, for this account only.
  resetSplitState();
  loadSplitFor("me");
  assert.deepEqual(ids(), ["b", "c"]);
  assert.equal(splitState().focus, 0);
  resetSplitState();
  loadSplitFor("someone-else");
  assert.deepEqual(ids(), []);
  // With no sessions left nothing is stored.
  resetSplitState();
  loadSplitFor("me");
  dropSession("b");
  dropSession("c");
  assert.equal(storage.getItem("claudex.splitView.v1.me"), null);
});

test("the panes on screen are the ones a finished reply need not mark unread", () => {
  openInSplit("b", "a");
  assert.deepEqual([...splitSessionIds()], []);
  setSplitState({ shown: true });
  assert.deepEqual([...splitSessionIds()], ["b"]);
});
