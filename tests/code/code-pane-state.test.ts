import test from "node:test";
import assert from "node:assert/strict";
import {
  codePaneStateKey,
  emptyCodePaneState,
  readCodePaneState,
  reconcileCodePaneState,
} from "../../src/app/code-pane-state";
import {
  codeTileIds,
  moveCodeTileToEdge,
} from "../../src/app/code-pane-layout-model";
test("pane closure and reopen restore source anchor topology without changing other leaves", () => {
  let state = reconcileCodePaneState(emptyCodePaneState(), [
    "files",
    "changes",
  ]);
  state = {
    ...state,
    layout: moveCodeTileToEdge(
      moveCodeTileToEdge(state.layout, "files", "left"),
      "files",
      "top",
    ),
  };
  const before = JSON.stringify(state.layout);
  state = reconcileCodePaneState(state, ["changes"]);
  assert.ok(state.closed.files);
  assert.deepEqual(codeTileIds(state.layout.root), ["chat", "changes"]);
  state = reconcileCodePaneState(state, ["changes", "files"]);
  assert.equal(state.layout.root.direction, "column");
  assert.deepEqual(codeTileIds(state.layout.root), [
    "files",
    "chat",
    "changes",
  ]);
  assert.equal(state.closed.files, undefined);
  assert.equal(reconcileCodePaneState(state, ["changes", "files"]), state);
  assert.ok(before.includes('"column"'));
});
test("layout storage is account/session scoped, bounded and failure tolerant", () => {
  const a = codePaneStateKey("a:b", "c"),
    b = codePaneStateKey("a", "b:c");
  assert.notEqual(a, b);
  const known = ["files", "changes"];
  for (const raw of [null, "{", "null", "{}", "x".repeat(100001)]) {
    const read = readCodePaneState({ getItem: () => raw }, a, known);
    assert.deepEqual(codeTileIds(read.layout.root), ["chat"]);
  }
  let state = reconcileCodePaneState(emptyCodePaneState(), known);
  state = reconcileCodePaneState(state, ["changes"]);
  const restored = readCodePaneState(
    { getItem: () => JSON.stringify(state) },
    a,
    known,
  );
  assert.ok(restored.closed.files);
  assert.deepEqual(codeTileIds(restored.layout.root), ["chat", "changes"]);
  assert.deepEqual(
    codeTileIds(
      readCodePaneState(
        {
          getItem() {
            throw Error("unavailable");
          },
        },
        a,
        known,
      ).layout.root,
    ),
    ["chat"],
  );
});
