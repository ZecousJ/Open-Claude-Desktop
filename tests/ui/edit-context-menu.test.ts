import assert from "node:assert/strict";
import test from "node:test";
import { useElectronShim } from "../runner/runner-core-support.test.ts";

useElectronShim();
const { editMenuTemplate, selectionMenuTemplate } =
  await import("../../electron/app/edit-context-menu");

test("a text field's menu is Cut, Copy, Paste, greyed when they can't act (R-1618)", () => {
  const flags = {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: true,
    canDelete: false,
    canSelectAll: false,
    canEditRichly: false,
  };
  assert.deepEqual(editMenuTemplate({ editFlags: flags }), [
    { role: "cut", enabled: false },
    { role: "copy", enabled: false },
    { role: "paste", enabled: true },
  ]);
});

test("selected reply text opens Look Up (macOS only) and Copy (R-0587)", () => {
  const lookUp = () => {};
  const mac = selectionMenuTemplate(
    "  a very long selected sentence here ",
    "darwin",
    lookUp,
  );
  assert.equal(mac.length, 2);
  assert.equal(mac[0].label, "Look Up “a very long selected…”");
  assert.deepEqual(mac[1], { role: "copy" });
  assert.deepEqual(selectionMenuTemplate("word", "win32", lookUp), [
    { role: "copy" },
  ]);
});
