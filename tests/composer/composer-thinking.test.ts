import test from "node:test";
import assert from "node:assert/strict";
import {
  chatEffortLevels,
  toggledThinkingEffort,
} from "../../shared/chat-effort";
import { thinkingShortcut } from "../../src/composer/thinking-shortcut";
import {
  desktopShortcutSections,
  webShortcutSections,
} from "../../src/dialogs/KeyboardShortcutsDialog";

test("thinking toggles supported Codex effort without claiming reasoning can be disabled", () => {
  assert.equal(toggledThinkingEffort("low", chatEffortLevels), "high");
  for (const effort of ["medium", "high", "xhigh", "max"] as const)
    assert.equal(toggledThinkingEffort(effort, chatEffortLevels), "low");
  assert.equal(toggledThinkingEffort("low", ["low", "medium"]), "medium");
  assert.equal(toggledThinkingEffort("low", ["low"]), undefined);
  assert.equal(toggledThinkingEffort("high", ["medium", "high"]), undefined);
});

test("Toggle thinking matches Cmd/Ctrl Shift E, not browser keys, composition or repeats", () => {
  const event = {
    key: "E",
    metaKey: true,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    isComposing: false,
    repeat: false,
  };
  assert.equal(thinkingShortcut(event, "darwin"), true);
  assert.equal(thinkingShortcut(event, "win32"), false);
  assert.equal(
    thinkingShortcut({ ...event, metaKey: false, ctrlKey: true }, "win32"),
    true,
  );
  assert.equal(
    thinkingShortcut({ ...event, metaKey: false, ctrlKey: true }, "linux"),
    true,
  );
  for (const patch of [
    { shiftKey: false },
    { altKey: true },
    { ctrlKey: true },
    { isComposing: true },
    { repeat: true },
    { key: "i" },
  ])
    assert.equal(thinkingShortcut({ ...event, ...patch }, "darwin"), false);
});

test("desktop and web list Toggle thinking in chats while Code keeps its effort shortcut", () => {
  for (const sections of [desktopShortcutSections, webShortcutSections]) {
    for (const platform of ["darwin", "win32", "linux"]) {
      const rows = sections(platform).flatMap((section) => section.shortcuts);
      assert.deepEqual(
        rows.find((row) => row.action === "Toggle thinking")?.keys,
        [["shift", "mod", "E"]],
      );
      assert.equal(
        sections(platform, "code")
          .flatMap((section) => section.shortcuts)
          .some((row) => row.action === "Toggle thinking"),
        false,
      );
    }
  }
});
