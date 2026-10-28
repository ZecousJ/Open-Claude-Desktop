import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  attachmentLimitNotice,
  maxAttachmentsFor,
} from "../../src/composer/attachment-limits";
import { contextSummary } from "../../src/composer/context-usage";

// The popover's and the pill's stylesheets are empty modules here.
registerHooks({
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});
const { ContextPopover } = await import("../../src/composer/ContextPopover");
const { BashModePill } = await import("../../src/composer/BashModePill");
const { webShortcutSections } =
  await import("../../src/dialogs/KeyboardShortcutsDialog");

test("Code takes 20 attachments per message, Chat and Cowork 12, in the original's sentence", () => {
  assert.equal(maxAttachmentsFor("code"), 20);
  assert.equal(maxAttachmentsFor("chat"), 12);
  assert.equal(maxAttachmentsFor("cowork"), 12);
  assert.equal(
    attachmentLimitNotice(20),
    "You can add at most 20 attachments to a message. Please select fewer attachments.",
  );
});

test("the context popover summarises usage, and asks for a first message before any", () => {
  assert.equal(
    contextSummary({ used: 64_600, window: 258_400, fraction: 0.25 }),
    "25% used · 65k of 258k",
  );
  assert.equal(
    contextSummary({ used: 50_000, window: null, fraction: null }),
    "50,000 tokens",
  );
  const empty = renderToStaticMarkup(
    createElement(ContextPopover, {
      usage: { used: 0, window: 258_400, fraction: 0 },
      onCompact: () => {},
    }),
  );
  assert.match(empty, /Send a message to see context usage\./);
  assert.doesNotMatch(empty, /Compact session/);
  const used = renderToStaticMarkup(
    createElement(ContextPopover, {
      usage: { used: 64_600, window: 258_400, fraction: 0.25 },
      onCompact: () => {},
    }),
  );
  assert.match(used, /role="progressbar"[^>]*aria-valuenow="25"/);
  assert.match(used, /Compact session/);
  const busy = renderToStaticMarkup(
    createElement(ContextPopover, {
      usage: { used: 64_600, window: 258_400, fraction: 0.25 },
      onCompact: () => {},
      compactReason: "Available when Claudex finishes this turn",
    }),
  );
  assert.match(busy, /disabled=""[^>]*title="Available when Claudex finishes/);
  assert.match(
    busy,
    /<span id="[^"]+" class="context-popover-hint">Available when Claudex finishes this turn<\/span><button/,
    "the reason is a text beside the button, as well as its title",
  );
  assert.doesNotMatch(used, /context-popover-hint/);
  // The popover offers no Hand off.
  assert.doesNotMatch(used, /Hand off to new session/);
});

test("Bash mode marks itself with a bash pill titled as the original's", () => {
  const html = renderToStaticMarkup(createElement(BashModePill));
  assert.match(html, /title="Run as a shell command"/);
  assert.match(html, />bash</);
});

test("the shortcut list names Esc, queueing and Code's menus", () => {
  const rows = (platform: string, context: "chat" | "code" = "code") =>
    Object.fromEntries(
      webShortcutSections(platform, context)
        .flatMap((section) => section.shortcuts)
        .map((s) => [s.action, s.keys[0].join("+")]),
    );
  const mac = rows("darwin");
  assert.equal(mac["Stop Claudex’s response"], "Esc");
  assert.equal(mac["Queue for later (while Claudex is working)"], "mod+enter");
  assert.equal(mac["Open model menu"], "shift+mod+I");
  assert.equal(mac["Open effort selector"], "shift+mod+E");
  // The web's mode menu key leaves ⇧⌘M to the browser.
  assert.equal(mac["Open mode menu"], "alt+mod+M");
  // Ctrl+Shift+I is the developer tools outside macOS.
  assert.equal(rows("win32")["Open model menu"], undefined);
  assert.equal(rows("win32")["Open effort selector"], "shift+mod+E");
  // Chats open their model menu with ⇧⌘. and have no effort selector.
  const chat = rows("win32", "chat");
  assert.equal(chat["Open model menu"], "shift+mod+.");
  assert.equal(chat["Edit your last message"], "Esc+Esc");
  assert.equal(chat["Toggle thinking"], "shift+mod+E");
  assert.equal(chat["Queue for later"], "mod+enter");
  assert.equal(chat["Toggle side chat"], undefined);
  assert.equal(chat["Pin / unpin chat"], "mod+alt+P");
  assert.equal(mac["Toggle side chat"], "mod+;");
  assert.equal(chat["Open effort selector"], undefined);
  assert.deepEqual(
    webShortcutSections("darwin", "chat").map((s) => s.title),
    ["General", "In chats"],
  );
  // Code's list has the live bundle's sections.
  assert.deepEqual(
    webShortcutSections("darwin", "code").map((s) => s.title),
    ["General", "Panes", "Composer"],
  );
  // The live order: thinking follows Queue.
  assert.deepEqual(
    webShortcutSections("darwin", "chat")[1]
      .shortcuts.map((s) => s.action)
      .slice(0, 9),
    [
      "Send message",
      "New line in message",
      "Queue for later",
      "Toggle thinking",
      "Toggle browser",
      "Jump to Browser tab",
      "Open model menu",
      "Add files or photos",
      "Stop Claudex’s response",
    ],
  );
  assert.equal(chat["Toggle thinking"], "shift+mod+E");
});

test("Max effort carries no warning", async () => {
  const { CodeEffortSlider } =
    await import("../../src/composer/code/CodeEffortSlider");
  const html = renderToStaticMarkup(
    createElement(CodeEffortSlider, { value: "max", onChange: () => {} }),
  );
  assert.match(html, /aria-label="Effort: Max"/);
  assert.doesNotMatch(html, /Warning|High usage|limits faster/);
});
