/**
 * The unified sidebar: the lists' titles once Chat and Cowork are one home, the
 * row numbers while ⌘ or Ctrl+Shift is held, a held Ctrl+Tab stepping on, and
 * ⌘⌥← / ⌘⌥→ between the sidebar's tabs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { historyLabels, recentsTitle } from "../../src/sidebar/recents-labels";
import {
  hideJumpHints,
  hintKeyOf,
  hintsFor,
  holdsCtrlShift,
  holdsHintChord,
  rowForDigit,
  showJumpHints,
  shownJumpHints,
  shownRowIds,
} from "../../src/sidebar/jump-hints";
import {
  heldKeyRuns,
  heldStepFloorMs,
} from "../../src/app/useKeyboardCommands";
import {
  sidebarTabShortcut,
  sidebarTabStep,
  sidebarTabTarget,
} from "../../src/sidebar/sidebar-tab-keys";
import { desktopShortcutSections } from "../../src/dialogs/KeyboardShortcutsDialog";

const press = (patch: Partial<Record<string, boolean>> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...patch,
});

test("every host presents chat and legacy tasks in unified Recents", () => {
  assert.equal(recentsTitle("cowork", true), "Recents");
  assert.equal(recentsTitle("chat", true), "Recents");
  assert.equal(recentsTitle("chat", false), "Recents");
  assert.equal(recentsTitle("code", false), "Recents");
  assert.deepEqual(historyLabels("chat", true), {
    title: "Recents",
    searchPlaceholder: "Search recents...",
    searchLabel: "Search your activity",
    newLabel: "New session",
  });
  assert.equal(historyLabels("chat", false).title, "Recents");
  assert.equal(historyLabels("chat", false).newLabel, "New session");
  assert.equal(historyLabels("code", true).title, "Sessions");
  assert.equal(historyLabels("code", true).newLabel, "New session");
});

test("⌘ alone (Ctrl outside macOS) on the desktop, or Ctrl+Shift anywhere, holds the numbers", () => {
  const desktopMac = { desktop: true, mac: true };
  const web = { desktop: false, mac: true };
  assert.equal(holdsHintChord(press({ metaKey: true }), desktopMac), true);
  assert.equal(holdsHintChord(press({ metaKey: true }), web), false);
  assert.equal(
    holdsHintChord(press({ ctrlKey: true }), { desktop: true, mac: false }),
    true,
  );
  assert.equal(
    holdsHintChord(press({ metaKey: true, shiftKey: true }), desktopMac),
    false,
  );
  assert.equal(
    holdsHintChord(press({ ctrlKey: true, shiftKey: true }), web),
    true,
  );
  assert.equal(
    holdsCtrlShift(press({ ctrlKey: true, shiftKey: true, altKey: true })),
    false,
  );
});

test("a digit is read from the physical key, so Shift+1 is still 1", () => {
  assert.equal(hintKeyOf({ key: "!", code: "Digit1" }), "1");
  assert.equal(hintKeyOf({ key: "K", code: "KeyK" }), "k");
  assert.equal(hintKeyOf({ key: "Tab", code: "Tab" }), null);
});

test("the first nine rows on screen are numbered; hidden rows are skipped", () => {
  const rows = [
    { dataset: { conversationId: "a" }, offsetParent: {} },
    { dataset: { conversationId: "hidden" }, offsetParent: null },
    { dataset: { conversationId: "a" }, offsetParent: {} },
    ...Array.from({ length: 10 }, (_, i) => ({
      dataset: { conversationId: `r${i}` },
      offsetParent: {},
    })),
  ];
  const root = { querySelectorAll: () => rows } as never;
  const ids = shownRowIds(root);
  assert.equal(ids.length, 9);
  assert.deepEqual(ids.slice(0, 2), ["a", "r0"]);
  const hints = hintsFor(ids);
  assert.equal(hints.a, "1");
  assert.equal(hints.r7, "9");
  assert.equal(rowForDigit(hints, "2"), "r0");
  assert.equal(rowForDigit(null, "2"), undefined);

  showJumpHints(root);
  assert.equal(shownJumpHints()?.a, "1");
  hideJumpHints();
  assert.equal(shownJumpHints(), null);
});

test("a held Next / Previous steps again 50ms after its last step; other keys run once", () => {
  assert.equal(heldKeyRuns("next-session", false, 0), true);
  assert.equal(
    heldKeyRuns("browser-next-tab", true, heldStepFloorMs - 1),
    false,
  );
  assert.equal(heldKeyRuns("browser-next-tab", true, heldStepFloorMs), true);
  assert.equal(heldKeyRuns("previous-session", true, 80), true);
  assert.equal(heldKeyRuns("toggle-sidebar", true, 1000), false);
});

test("⌘⌥→ and ⌘⌥← move between the sidebar's tabs without wrapping", () => {
  const tabs = ["chat", "code"] as const;
  const arrow = (key: string, patch = {}) => ({ key, ...press(patch) });
  assert.equal(
    sidebarTabStep(arrow("ArrowRight", { metaKey: true, altKey: true }), true),
    1,
  );
  assert.equal(
    sidebarTabStep(arrow("ArrowLeft", { ctrlKey: true, altKey: true }), false),
    -1,
  );
  assert.equal(
    sidebarTabStep(arrow("ArrowLeft", { ctrlKey: true, altKey: true }), true),
    0,
  );
  assert.equal(sidebarTabStep(arrow("ArrowRight", { metaKey: true }), true), 0);
  assert.equal(sidebarTabTarget(tabs, "chat", 1), "code");
  assert.equal(sidebarTabTarget(tabs, "code", 1), undefined);
  assert.equal(sidebarTabTarget(tabs, "code", -1), "chat");
  assert.deepEqual(sidebarTabShortcut(tabs, "code", "chat"), [
    "mod",
    "alt",
    "→",
  ]);
  assert.deepEqual(sidebarTabShortcut(tabs, "chat", "code"), [
    "mod",
    "alt",
    "←",
  ]);
  assert.equal(sidebarTabShortcut(tabs, "chat", "chat"), undefined);
});

test("the desktop's shortcut lists name Next and Previous sidebar tab after the jump keys", () => {
  const chat = desktopShortcutSections("darwin")[0].shortcuts.map(
    (s) => s.action,
  );
  assert.deepEqual(chat.slice(chat.indexOf("Jump to chat") + 1).slice(0, 2), [
    "Next sidebar tab",
    "Previous sidebar tab",
  ]);
  const code = desktopShortcutSections("darwin", "code")[0].shortcuts.map(
    (s) => s.action,
  );
  assert.equal(code[code.indexOf("Jump to session") + 1], "Next sidebar tab");
});
