import test from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFF_GRACE_MS,
  handoffKey,
  handsFocus,
  initialHandoff,
  syntheticPointer,
  type HandoffState,
} from "../../src/approval/focus-handoff";

const state = (patch: Partial<HandoffState> = {}): HandoffState => ({
  ...initialHandoff(),
  ...patch,
});
const enter = (extra: Record<string, unknown> = {}) => ({
  key: "Enter",
  repeat: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

test("focus moves on only when the card was answered from the keyboard", () => {
  assert.equal(handsFocus(state({ inside: true, keyAt: 100 })), true);
  // A click in the card after the last key press: a mouse decision.
  assert.equal(
    handsFocus(state({ inside: true, keyAt: 100, pressedAt: 200 })),
    false,
  );
  // Focus was in the composer (⌘↩ from there): nothing to hand on.
  assert.equal(handsFocus(state({ inside: false, keyAt: 100 })), false);
});

test("a button's keyboard click is not a pointer press", () => {
  assert.equal(
    syntheticPointer({ pointerType: "", width: 0, height: 0 }),
    true,
  );
  assert.equal(
    syntheticPointer({ pointerType: "mouse", width: 1, height: 1 }),
    false,
  );
  assert.equal(
    syntheticPointer({ pointerType: "touch", width: 0, height: 0 }),
    false,
  );
});

test("⌘↩ right after focus went back to the composer is swallowed", () => {
  const s = state({ composerAt: 1000 });
  assert.equal(handoffKey(enter({ metaKey: true }), false, s, 1200), "swallow");
  assert.equal(handoffKey(enter({ ctrlKey: true }), false, s, 1200), "swallow");
  assert.equal(
    handoffKey(enter({ metaKey: true }), false, s, 1000 + HANDOFF_GRACE_MS),
    undefined,
  );
  // A plain Enter in the composer is the composer's.
  assert.equal(handoffKey(enter(), false, s, 1200), undefined);
});

test("Enter on a card handed focus moves to its primary button, once the grace has passed", () => {
  const s = state({ wentAt: 1000 });
  assert.equal(handoffKey(enter(), true, s, 1100), "swallow");
  assert.equal(handoffKey(enter(), true, s, 1500), "primary");
  assert.equal(handoffKey(enter({ repeat: true }), true, s, 1500), "swallow");
  assert.equal(handoffKey(enter({ shiftKey: true }), true, s, 1500), "swallow");
  // ⌘↩ stays the card's own shortcut.
  assert.equal(handoffKey(enter({ metaKey: true }), true, s, 1500), undefined);
  // Other keys (the card's digits) are not the hand-off's.
  assert.equal(handoffKey(enter({ key: "3" }), true, s, 1500), undefined);
  // Enter elsewhere is left alone.
  assert.equal(handoffKey(enter(), false, s, 1100), undefined);
});
