/**
 * Ctrl+Tab, Ctrl+Shift+Tab and ⌘1 to ⌘9 switch chats (Next chat, Previous chat,
 * Jump to chat) unless the focus is in the Browser, whose tabs they switch
 * then.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  chatKeyOwner,
  focusForChatKeys,
  jumpTarget,
} from "../../src/app/session-cycle";
import { browserTabFor } from "../../src/app/shell-menu";
import { commandForKey, keyTable } from "../../src/host/keys";

const { desktopShortcutSections, webShortcutSections } =
  await import("../../src/dialogs/KeyboardShortcutsDialog");

test("⌘1 to ⌘9 open the sidebar's n-th row, never past the list", () => {
  const ids = ["a", "b", "c"];
  assert.equal(jumpTarget(ids, undefined, 1), "a");
  assert.equal(jumpTarget(ids, "a", 3), "c");
  // The open row stays; a number past the list does nothing.
  assert.equal(jumpTarget(ids, "b", 2), undefined);
  assert.equal(jumpTarget(ids, "a", 4), undefined);
  // ⌘9 is the ninth row, not the last (unlike the Browser's ⌘9).
  const many = Array.from({ length: 12 }, (_, i) => `c${i + 1}`);
  assert.equal(jumpTarget(many, undefined, 9), "c9");
  assert.equal(jumpTarget(many, undefined, 0), undefined);
});

test("the focus decides who owns the chat keys", () => {
  const none = { inBrowserPane: false, inBrowserPage: false, inPicker: false };
  assert.equal(chatKeyOwner(none), "chats");
  assert.equal(chatKeyOwner({ ...none, inBrowserPane: true }), "browser");
  assert.equal(chatKeyOwner({ ...none, inBrowserPage: true }), "browser");
  assert.equal(chatKeyOwner({ ...none, inPicker: true }), "none");
});

test("focus facts come from the document", () => {
  const element = (matches: string[]) => ({
    closest: (selector: string) =>
      matches.some((m) => selector.includes(m)) ? {} : null,
  });
  const doc = (active: unknown, focused = true) => ({
    activeElement: active as Element,
    hasFocus: () => focused,
  });
  assert.deepEqual(focusForChatKeys(doc(element([])), true), {
    inBrowserPane: false,
    inBrowserPage: false,
    inPicker: false,
  });
  assert.equal(
    focusForChatKeys(doc(element([".browser-panel"])), true).inBrowserPane,
    true,
  );
  assert.equal(
    focusForChatKeys(doc(element(['[role="listbox"]'])), false).inPicker,
    true,
  );
  // The window without the focus means the Browser's page has it, but only
  // while the Browser is open.
  assert.equal(focusForChatKeys(doc(null, false), true).inBrowserPage, true);
  assert.equal(focusForChatKeys(doc(null, false), false).inBrowserPage, false);
});

test("the Browser's ⌘9 is its last tab", () => {
  assert.equal(browserTabFor({ tab: 9 }, ["t1", "t2"], "t1"), "t2");
  assert.equal(browserTabFor({ tab: 2 }, ["t1", "t2"], "t1"), "t2");
});

test("the desktop's window keys reach the chat-switching commands", () => {
  const table = keyTable("desktop", "darwin");
  const key = (
    k: string,
    mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey", boolean>>,
  ) =>
    commandForKey(
      {
        key: k,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...mods,
      },
      table,
    );
  assert.equal(key("Tab", { ctrlKey: true }), "browser-next-tab");
  assert.equal(
    key("Tab", { ctrlKey: true, shiftKey: true }),
    "browser-previous-tab",
  );
  assert.equal(key("3", { metaKey: true }), "browser-tab-3");
  // The web leaves these keys to the browser.
  const web = keyTable("web", "MacIntel");
  assert.equal(
    commandForKey(
      {
        key: "3",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      },
      web,
    ),
    undefined,
  );
});

test("the shortcuts list Next chat, Previous chat and Jump to chat", () => {
  const [general] = desktopShortcutSections("darwin");
  const actions = general.shortcuts.map((s) => s.action);
  const at = actions.indexOf("New chat");
  assert.deepEqual(actions.slice(at, at + 4), [
    "New chat",
    "Next chat",
    "Previous chat",
    "Jump to chat",
  ]);
  // No Close chat without the desktop's chat tabs.
  assert.equal(actions.includes("Close chat"), false);
  const code = desktopShortcutSections("darwin", "code")[0].shortcuts.map(
    (s) => s.action,
  );
  assert.equal(code[code.indexOf("Previous session") + 1], "Jump to session");
  // The web has none of them.
  const web = webShortcutSections("MacIntel")[0].shortcuts.map((s) => s.action);
  assert.equal(web.includes("Next chat"), false);
});
