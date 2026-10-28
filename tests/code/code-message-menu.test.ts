import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  codeMessageMenu,
  messageSelection,
} from "../../src/transcript/code-message-menu";
import { messageExcerptLabel } from "../../src/composer/terminal-excerpt";
import { CodeUserMessage } from "../../src/transcript/CodeUserMessage";
import type { Turn } from "../../shared/types";
import type { MenuEntry } from "../../src/ui/Menu";

const shape = (entries: MenuEntry[]) =>
  entries.map((entry) =>
    "separator" in entry ? "-" : "label" in entry ? entry.label : "?",
  );
const noop = () => {};

test("a message menu reads Copy, Copy as Markdown, Attach, Pin as chapter, Rewind, Fork", () => {
  assert.deepEqual(
    shape(
      codeMessageMenu({
        copy: noop,
        onAttach: noop,
        onRewind: noop,
        onFork: noop,
      }),
    ),
    [
      "Copy message",
      "Copy message as Markdown",
      "-",
      "Attach message as context",
      "Pin as chapter",
      "-",
      "Rewind to here",
      "Fork from here",
    ],
  );
});

test("Attach says selection and shows the keys only while text is selected", () => {
  const whole = codeMessageMenu({ copy: noop, onAttach: noop });
  const attach = whole.find(
    (entry) => "label" in entry && /Attach/.test(entry.label),
  );
  assert.ok(attach && "label" in attach);
  assert.equal(attach.label, "Attach message as context");
  assert.equal(attach.shortcut, undefined);
  const picked = codeMessageMenu({
    copy: noop,
    onAttach: noop,
    selection: "some words",
    mac: false,
  }).find((entry) => "label" in entry && /Attach/.test(entry.label));
  assert.ok(picked && "label" in picked);
  assert.equal(picked.label, "Attach selection as context");
  assert.deepEqual(picked.shortcut, ["shift", "mod", "L"]);
});

test("without a handler the menu has no Attach item", () => {
  assert.deepEqual(shape(codeMessageMenu({ copy: noop, onRewind: noop })), [
    "Copy message",
    "Copy message as Markdown",
    "-",
    "Pin as chapter",
    "-",
    "Rewind to here",
  ]);
  assert.deepEqual(shape(codeMessageMenu({ copy: noop })), [
    "Copy message",
    "Copy message as Markdown",
  ]);
});

test("a selection counts from two characters after trimming", () => {
  assert.equal(messageSelection(" a "), undefined);
  assert.equal(messageSelection("  ab \n"), "ab");
});

test("an excerpt from a message is named after its first line, cut at 60", () => {
  assert.equal(
    messageExcerptLabel("\n  fix the build \nthen test"),
    "fix the build",
  );
  const long = "x".repeat(61);
  assert.equal(messageExcerptLabel(long), `${"x".repeat(59)}…`);
  assert.equal(messageExcerptLabel("y".repeat(60)), "y".repeat(60));
});

test("a Code prompt takes the context menu with only Attach wired", () => {
  const turn = {
    id: "t",
    prompt: "hello",
    createdAt: 0,
    status: "completed",
    items: [],
  } as unknown as Turn;
  const html = renderToStaticMarkup(
    createElement(CodeUserMessage, { turn, onAttachAsContext: noop }),
  );
  assert.match(html, /user-message/);
});
