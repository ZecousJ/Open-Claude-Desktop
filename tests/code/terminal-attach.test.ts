import test from "node:test";
import assert from "node:assert/strict";
import type { Attachment } from "../../shared/types";
import type { MenuEntry } from "../../src/ui/Menu";
import {
  attachableSelection,
  terminalCanvasMenu,
  terminalKey,
} from "../../src/terminal/terminal-menu";
import { attachTerminalSelection } from "../../src/composer/terminal-excerpt";
import { excerptLabel, pastedText } from "../../src/composer/attachment-input";

const labels = (entries: MenuEntry[]) =>
  entries.map((entry) =>
    "separator" in entry ? "-" : "label" in entry ? entry.label : "",
  );
const noop = () => {};
const actions = {
  attach: noop,
  copy: noop,
  paste: noop,
  selectAll: noop,
  clear: noop,
};

test("Attach selection as context is offered only for a selection with text", () => {
  assert.deepEqual(labels(terminalCanvasMenu("", actions)), [
    "Copy",
    "Paste",
    "-",
    "Select all",
    "-",
    "Clear terminal",
  ]);
  // Only blanks selected: nothing to attach, but Copy still has a selection.
  const blank = terminalCanvasMenu("  \n ", actions);
  assert.equal(labels(blank)[0], "Copy");
  assert.equal("disabled" in blank[0] && blank[0].disabled, false);
  assert.deepEqual(labels(terminalCanvasMenu("npm test", actions)), [
    "Attach selection as context",
    "-",
    "Copy",
    "Paste",
    "-",
    "Select all",
    "-",
    "Clear terminal",
  ]);
});

test("Copy is greyed without a selection and the item hands over the trimmed text", () => {
  const none = terminalCanvasMenu("", actions);
  assert.equal("disabled" in none[0] && none[0].disabled, true);
  const attached: string[] = [];
  const entries = terminalCanvasMenu("\n  error: boom \n", {
    ...actions,
    attach: (text) => attached.push(text),
  });
  const item = entries[0];
  assert.ok("onSelect" in item);
  item.onSelect?.();
  assert.deepEqual(attached, ["error: boom"]);
  assert.equal(attachableSelection(" \n "), undefined);
});

test("the item is left out where no composer can take the context", () => {
  const { attach: _, ...rest } = actions;
  assert.equal(labels(terminalCanvasMenu("ls", rest))[0], "Copy");
});

function draft(attachments: Attachment[] = [], mode: "code" | "chat" = "code") {
  const state = {
    attachments,
    notices: [] as string[],
    focused: 0,
    open: true,
  };
  return {
    state,
    value: {
      mode,
      attachments,
      setAttachments: (update: (current: Attachment[]) => Attachment[]) => {
        state.attachments = update(state.attachments);
      },
      notify: (message: string) => state.notices.push(message),
      stillOpen: () => state.open,
      focus: () => {
        state.focused += 1;
      },
    },
  };
}
function stubDesktop() {
  const added: { name: string; text: string; options: unknown }[] = [];
  (globalThis as any).window = {
    desktop: {
      addAttachmentData: async (
        name: string,
        data: Uint8Array,
        options: unknown,
      ) => {
        added.push({ name, text: new TextDecoder().decode(data), options });
        return {
          id: `a${added.length}`,
          name,
          path: `/tmp/${name}`,
          kind: "text",
          size: data.byteLength,
          pasted: true,
        } satisfies Attachment;
      },
    },
  };
  return added;
}

test("the selection joins the draft as an excerpt card named after the terminal", async () => {
  const added = stubDesktop();
  const { state, value } = draft();
  await attachTerminalSelection(value, "npm test\nok", "Terminal 2");
  assert.deepEqual(added, [
    { name: "Terminal 2.txt", text: "npm test\nok", options: { pasted: true } },
  ]);
  assert.equal(state.attachments.length, 1);
  const [card] = state.attachments;
  assert.equal(excerptLabel(card.id), "Terminal 2");
  assert.equal(pastedText(card.id), "npm test\nok");
  assert.equal(state.focused, 1);
});

test("a full message gets the attachment limit notice instead", async () => {
  const added = stubDesktop();
  const full = Array.from({ length: 20 }, (_, index) => ({
    id: `f${index}`,
    name: `f${index}.txt`,
    path: `/tmp/f${index}.txt`,
    kind: "text" as const,
    size: 1,
  }));
  const { state, value } = draft(full);
  await attachTerminalSelection(value, "x", "Terminal");
  assert.equal(added.length, 0);
  assert.equal(state.attachments.length, 20);
  assert.match(state.notices[0], /at most 20 attachments/);
});

test("a draft that was closed meanwhile gets nothing", async () => {
  stubDesktop();
  const { state, value } = draft();
  state.open = false;
  await attachTerminalSelection(value, "x", "Terminal");
  assert.equal(state.attachments.length, 0);
  assert.equal(state.focused, 0);
});

test("the terminal menu shows its keys for the platform", () => {
  const shortcuts = (entries: MenuEntry[]) =>
    entries.flatMap((entry) =>
      "label" in entry ? [[entry.label, entry.shortcut?.join("+")]] : [],
    );
  assert.deepEqual(shortcuts(terminalCanvasMenu("ls", actions, true)), [
    ["Attach selection as context", "shift+mod+L"],
    ["Copy", "mod+C"],
    ["Paste", "mod+V"],
    ["Select all", "mod+A"],
    ["Clear terminal", undefined],
  ]);
  assert.deepEqual(shortcuts(terminalCanvasMenu("ls", actions, false)), [
    ["Attach selection as context", "shift+mod+L"],
    ["Copy", "ctrl+shift+C"],
    ["Paste", "ctrl+shift+V"],
    ["Select all", undefined],
    ["Clear terminal", undefined],
  ]);
});

test("the terminal takes Attach, and off macOS Copy and Paste, from the keyboard", () => {
  const press = (key: string, extra: Record<string, boolean> = {}) => ({
    type: "keydown",
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...extra,
  });
  const meta = { metaKey: true, shiftKey: true };
  const ctrl = { ctrlKey: true, shiftKey: true };
  assert.equal(terminalKey(press("L", meta), true), "attach");
  assert.equal(terminalKey(press("L", ctrl), false), "attach");
  // macOS leaves ⌘C, ⌘V and ⌘A to xterm; Ctrl+Shift+L is not ⇧⌘L there.
  assert.equal(terminalKey(press("c", { metaKey: true }), true), undefined);
  assert.equal(terminalKey(press("C", meta), true), undefined);
  assert.equal(terminalKey(press("L", ctrl), true), undefined);
  assert.equal(terminalKey(press("C", ctrl), false), "copy");
  assert.equal(terminalKey(press("V", ctrl), false), "paste");
  // Ctrl+C without Shift still interrupts the shell; a key-up does nothing.
  assert.equal(terminalKey(press("c", { ctrlKey: true }), false), undefined);
  assert.equal(
    terminalKey({ ...press("C", ctrl), type: "keyup" }, false),
    undefined,
  );
});
