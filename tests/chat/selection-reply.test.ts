import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

registerHooks({
  load: (url, context, next) =>
    url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context),
});
const { quoteSelection, SelectionReplyActions } =
  await import("../../src/transcript/SelectionReply");

test("Reply quotes the selection into the composer (R-0526)", () => {
  assert.equal(quoteSelection(" two\nlines "), "> two\n> lines\n\n");
});

test("selection offers an accessible microphone and shortcut only when dictation is available", () => {
  const off = renderToStaticMarkup(
    createElement(SelectionReplyActions, { onReply() {} }),
  );
  assert.match(off, /Reply/);
  assert.doesNotMatch(off, /Dictate a reply|selection-dictate/);
  const on = renderToStaticMarkup(
    createElement(SelectionReplyActions, {
      onReply() {},
      onDictate() {},
      shortcut: "Control+D",
      platform: "linux",
    }),
  );
  assert.match(on, /aria-label="Dictate a reply"/);
  assert.match(on, /aria-keyshortcuts="Control\+D"/);
  assert.match(on, /selection-dictate/);
});

test("unavailable dictation uses the official label and unavailable tooltip, not a service-specific reason", async () => {
  const { UnavailableDictationButton } =
    await import("../../src/composer/voice/DictationButton");
  const html = renderToStaticMarkup(
    createElement(UnavailableDictationButton, {
      reason: "A provider-specific reason",
    }),
  );
  assert.match(html, /aria-label="Dictate"/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /Dictation is unavailable/);
  assert.doesNotMatch(html, /Dictate message|provider-specific/);
});
