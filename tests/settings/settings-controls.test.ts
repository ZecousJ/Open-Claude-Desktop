import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Button,
  Row,
  SelectField,
  Toggle,
  dropdownGap,
  dropdownPlacement,
  nextChoice,
} from "../../src/settings/controls";
import { Dropdown } from "../../src/settings/Dropdown";
import { tooltipPosition } from "../../src/ui/tooltip-position";
import {
  ShortcutRecorder,
  refusedShortcut,
  shortcutProblems,
} from "../../src/settings/ShortcutRecorder";
import { ConfirmationDialog } from "../../src/dialogs/ConfirmationDialog";

const view = { width: 1164, height: 1049 };

test("a choice list opens 6px below its trigger, right edges aligned, or above when only that fits", () => {
  const trigger = { top: 300, bottom: 332, right: 1068 };
  assert.equal(dropdownGap, 6);
  assert.deepEqual(dropdownPlacement(trigger, 104, view), {
    right: 96,
    top: 338,
  });
  const low = { top: 980, bottom: 1012, right: 1068 };
  assert.deepEqual(dropdownPlacement(low, 104, view), {
    right: 96,
    bottom: view.height - 980 + 6,
  });
  // Too tall for either side: pinned 8px from the bottom.
  assert.deepEqual(
    dropdownPlacement({ ...trigger, top: 60, bottom: 92 }, 1000, view),
    {
      right: 96,
      top: 41,
    },
  );
});

test("choice lists follow the arrow keys, Home/End and typed letters", () => {
  const labels = ["Slow", "Normal", "Fast"];
  assert.equal(nextChoice(labels, 1, "ArrowDown"), 2);
  assert.equal(nextChoice(labels, 2, "ArrowDown"), 0);
  assert.equal(nextChoice(labels, 0, "ArrowUp"), 2);
  assert.equal(nextChoice(labels, -1, "ArrowUp"), 2);
  assert.equal(nextChoice(labels, 1, "Home"), 0);
  assert.equal(nextChoice(labels, 0, "End"), 2);
  assert.equal(nextChoice(labels, 0, "f"), 2);
  assert.equal(nextChoice(labels, 0, "x"), undefined);
  assert.equal(nextChoice(labels, 0, "Tab"), undefined);
  assert.equal(nextChoice([], 0, "ArrowDown"), undefined);
});

test("settings controls render the roles assistive technology expects", () => {
  const toggle = renderToStaticMarkup(
    createElement(Toggle, { label: "Menu bar", checked: true }),
  );
  assert.match(toggle, /role="switch"/);
  assert.match(toggle, /aria-checked="true"/);
  const options = [
    { value: "a", label: "Tap Option twice" },
    { value: "b", label: "No shortcut" },
  ];
  const borderless = renderToStaticMarkup(
    createElement(Dropdown<string>, {
      label: "Speed",
      value: "b",
      options,
      onChange: () => {},
    }),
  );
  assert.match(borderless, /class="settings-dropdown /);
  assert.match(borderless, /aria-haspopup="listbox"/);
  assert.match(borderless, /aria-expanded="false"/);
  assert.match(borderless, /No shortcut/);
  const bordered = renderToStaticMarkup(
    createElement(SelectField<string>, {
      label: "Quick access shortcut",
      value: "a",
      options,
      width: 240,
      onChange: () => {},
    }),
  );
  assert.match(bordered, /class="settings-select /);
  assert.match(bordered, /width:240px/);
  const row = renderToStaticMarkup(
    createElement(Row, { label: "Motion", description: "Reduce animation." }),
  );
  assert.match(row, /data-setting="Motion"/);
});

test("row buttons come in the 28px and the 32px size of the captures", () => {
  const compact = renderToStaticMarkup(
    createElement(Button, { onClick: () => {}, children: "Log out" }),
  );
  assert.doesNotMatch(compact, /regular/);
  const regular = renderToStaticMarkup(
    createElement(Button, {
      size: "regular",
      onClick: () => {},
      children: "Manage",
    }),
  );
  assert.match(regular, /class="settings-button[^"]*\bregular\b/);
});

test("tooltips can sit above, end-aligned or further from their button", () => {
  const box = { left: 300, top: 1000, right: 332, bottom: 1032 };
  const size = { width: 40, height: 24 };
  assert.deepEqual(tooltipPosition(box, size, view, "above", 6), {
    left: 296,
    top: 970,
  });
  const edge = { left: 1120, top: 60, right: 1152, bottom: 92 };
  assert.deepEqual(
    tooltipPosition(edge, { width: 136, height: 24 }, view, "below-end", 6),
    { left: 1016, top: 98 },
  );
  // The default gap is the original's 4; with no room below it flips above.
  assert.deepEqual(tooltipPosition(box, size, view, "below"), {
    left: 296,
    top: 972,
  });
});

test("a confirmation names its action; deletions are red", () => {
  const render = (danger?: boolean) =>
    renderToStaticMarkup(
      createElement(ConfirmationDialog, {
        confirmation: {
          title: "Log out of all devices?",
          body: "Signs out every device.",
          confirm: "Log out",
          danger,
          action: async () => {},
        },
        onClose: () => {},
        onError: () => {},
      }),
    );
  assert.match(render(false), /role="alertdialog"/);
  assert.match(render(false), />Log out<\/button>/);
  assert.doesNotMatch(render(false), /danger-button/);
  assert.match(render(), /danger-button/);
  // No close button: Cancel and Escape close it.
  assert.doesNotMatch(render(), /aria-label="Close"/);
});

test("a shortcut field says 'Set shortcut' while empty and offers Clear shortcut once set", () => {
  const field = (value: string) =>
    renderToStaticMarkup(
      createElement(ShortcutRecorder, {
        label: "Quick Entry keyboard shortcut",
        value,
        platform: "darwin",
        onChange: () => {},
      }),
    );
  const empty = field("");
  assert.match(empty, /Set shortcut/);
  assert.doesNotMatch(empty, /Clear shortcut|shortcut-recorder-problem/);
  const set = field("Command+Shift+Space");
  assert.match(set, /⇧⌘Space/);
  assert.match(set, /title="Clear shortcut"/);
  assert.doesNotMatch(set, /Set shortcut/);
  assert.match(shortcutProblems.reserved, /reserved for common actions/);
  assert.match(shortcutProblems.unsupported, /isn’t supported/);
});

test("a shortcut the system refuses says another app holds it, or that it isn't supported", () => {
  // The desktop integration's registration error, as the bridge passes it on.
  assert.equal(
    refusedShortcut(
      new Error(
        "Error invoking remote method 'saveSettings': Error: Command+Space is used by another app. Choose a different shortcut.",
      ),
    ),
    "taken",
  );
  assert.match(shortcutProblems.taken, /already in use by another app/);
  assert.equal(refusedShortcut(new Error("Invalid settings")), "unsupported");
  assert.equal(refusedShortcut("offline"), "unsupported");
});
