import test from "node:test";
import assert from "node:assert/strict";
import { isComposingKey, isEditEndKey } from "../../src/ui/ime";
import { isRepeatPress } from "../../src/ui/repeat-guard";
import { TYPEAHEAD_RESET_MS, itemRole } from "../../src/ui/menu-keys";

const press = (
  key: string,
  extra: { isComposing?: boolean; keyCode?: number; repeat?: boolean } = {},
) => ({
  key,
  keyCode: extra.keyCode ?? 13,
  repeat: extra.repeat ?? false,
  nativeEvent: { isComposing: extra.isComposing ?? false },
});

test("an Enter that accepts an IME candidate does not end an edit", () => {
  assert.equal(isEditEndKey(press("Enter"), "Enter"), true);
  assert.equal(isEditEndKey(press("Escape"), "Escape"), true);
  // Chrome and Firefox flag the composing key.
  assert.equal(
    isEditEndKey(press("Enter", { isComposing: true }), "Enter"),
    false,
  );
  assert.equal(
    isEditEndKey(press("Escape", { isComposing: true }), "Escape"),
    false,
  );
  // Safari reports the composing Enter as keyCode 229 with isComposing false.
  assert.equal(isComposingKey(press("Enter", { keyCode: 229 })), true);
  assert.equal(isEditEndKey(press("Enter", { keyCode: 229 }), "Enter"), false);
});

test("a held Enter or Escape ends an edit only once", () => {
  assert.equal(isEditEndKey(press("Enter", { repeat: true }), "Enter"), false);
  assert.equal(
    isEditEndKey(press("Escape", { repeat: true }), "Escape"),
    false,
  );
  // Other keys are never edit-ending keys.
  assert.equal(isEditEndKey(press("a"), "Enter"), false);
});

const target = (matching: boolean) =>
  ({ matches: () => matching }) as unknown as EventTarget;

test("the auto-repeat of Enter and Space on a pressable control is swallowed", () => {
  const held = (key: string, matching: boolean, repeat = true) =>
    isRepeatPress({ key, repeat, target: target(matching) });
  assert.equal(held("Enter", true), true);
  assert.equal(held(" ", true), true);
  // The first press goes through.
  assert.equal(held("Enter", true, false), false);
  // Fields, other keys and non-elements are left alone.
  assert.equal(held("Enter", false), false);
  assert.equal(held("ArrowDown", true), false);
  assert.equal(
    isRepeatPress({ key: "Enter", repeat: true, target: null }),
    false,
  );
});

test("menu typeahead forgets typed letters after 500ms", () => {
  assert.equal(TYPEAHEAD_RESET_MS, 500);
});

test("a menu row is a plain item unless it has a checked state", () => {
  assert.equal(itemRole(undefined, "checkbox"), "menuitem");
  assert.equal(itemRole(undefined, "radio"), "menuitem");
  assert.equal(itemRole(false, "checkbox"), "menuitemcheckbox");
  assert.equal(itemRole(true, "checkbox"), "menuitemcheckbox");
  assert.equal(itemRole(false, "radio"), "menuitemradio");
});
