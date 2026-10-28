import assert from "node:assert/strict";
import test from "node:test";
import {
  acceleratorFromPress,
  acceleratorLabel,
  hasPrimaryModifier,
  pressProblem,
  pressMatches,
  reservedAccelerator,
  validAccelerator,
} from "../../shared/accelerator";

const press = (
  key: string,
  code: string,
  mods: Partial<KeyboardEvent> = {},
) => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

test("a key press becomes an accelerator only with a modifier (R-1424)", () => {
  assert.equal(
    acceleratorFromPress(
      press(" ", "Space", { ctrlKey: true, altKey: true }),
      "win32",
    ),
    "Control+Alt+Space",
  );
  assert.equal(acceleratorFromPress(press("d", "KeyD"), "win32"), undefined);
  assert.equal(
    acceleratorFromPress(
      press("Control", "ControlLeft", { ctrlKey: true }),
      "win32",
    ),
    undefined,
  );
  assert.equal(
    acceleratorFromPress(
      press("∂", "KeyD", { metaKey: true, altKey: true }),
      "darwin",
    ),
    "Command+Alt+D",
  );
  assert.ok(validAccelerator("Control+Alt+Space"));
  assert.ok(!validAccelerator("D"));
});

test("shortcuts read the platform's way and match presses", () => {
  assert.equal(
    acceleratorLabel("Control+Alt+Space", "win32"),
    "Ctrl+Alt+Space",
  );
  assert.equal(acceleratorLabel("CommandOrControl+D", "darwin"), "⌘D");
  assert.equal(acceleratorLabel("CommandOrControl+D", "win32"), "Ctrl+D");
  // Each platform's own order: ⌃⌥⇧⌘ on macOS, Win first elsewhere.
  assert.equal(acceleratorLabel("Command+Shift+Control+K", "darwin"), "⌃⇧⌘K");
  assert.equal(acceleratorLabel("Option+Space", "darwin"), "⌥Space");
  assert.equal(acceleratorLabel("Shift+Super+S", "win32"), "Win+Shift+S");
  assert.ok(
    pressMatches(
      press("d", "KeyD", { ctrlKey: true }),
      "CommandOrControl+D",
      "win32",
    ),
  );
  assert.ok(
    pressMatches(
      press("d", "KeyD", { metaKey: true }),
      "CommandOrControl+D",
      "darwin",
    ),
  );
  assert.ok(
    !pressMatches(
      press("d", "KeyD", { ctrlKey: true, shiftKey: true }),
      "CommandOrControl+D",
      "win32",
    ),
  );
});

test("shortcut fields refuse reserved combinations, bare keys and unnamed keys", () => {
  assert.equal(reservedAccelerator("Command+Q", "darwin"), true);
  assert.equal(reservedAccelerator("Command+,", "darwin"), true);
  assert.equal(reservedAccelerator("Control+C", "win32"), true);
  // Another modifier makes it a different combination.
  assert.equal(reservedAccelerator("Control+Shift+S", "win32"), false);
  assert.equal(reservedAccelerator("Command+D", "darwin"), false);
  // Command is the Windows key elsewhere: not the copy shortcut.
  assert.equal(reservedAccelerator("Super+C", "win32"), false);
  assert.equal(
    pressProblem(press("w", "KeyW", { metaKey: true }), "darwin"),
    "reserved",
  );
  assert.equal(pressProblem(press("d", "KeyD"), "win32"), "reserved");
  assert.equal(pressProblem(press("F5", "F5"), "win32"), undefined);
  assert.equal(
    pressProblem(press("d", "KeyD", { ctrlKey: true }), "win32"),
    undefined,
  );
  assert.equal(pressProblem(press("Shift", "ShiftLeft"), "win32"), undefined);
  assert.equal(
    pressProblem(press("Dead", "IntlBackslash", { ctrlKey: true }), "win32"),
    "unsupported",
  );
  assert.equal(hasPrimaryModifier("CommandOrControl+D"), true);
  assert.equal(hasPrimaryModifier("Alt+Space"), false);
  assert.equal(hasPrimaryModifier("F5"), false);
});
