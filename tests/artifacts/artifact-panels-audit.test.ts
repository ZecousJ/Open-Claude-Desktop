import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactsPage } from "../../src/artifacts/ArtifactsPage";
import { ArtifactRuntimeError } from "../../src/artifacts/ArtifactRuntimeError";
import { RenameArtifactDialog } from "../../src/artifacts/RenameArtifactDialog";
import { BrowserEmptyState } from "../../src/browser/BrowserEmptyState";
import type { Artifact } from "../../src/ui/components";
import {
  cleanTabName,
  forgetTab,
  tabLabel,
  tabNumber,
} from "../../src/terminal/terminal-tabs";

test("an empty Artifacts page shows the original's first-use illustration and copy", () => {
  const noop = async () => {};
  const html = renderToStaticMarkup(
    createElement(ArtifactsPage, {
      artifacts: [],
      onOpenArtifact() {},
      onCreate() {},
      onComment: noop,
      authorName: "Zed",
      onShareRequestConsumed() {},
      onDuplicate: noop,
      onPin: noop,
      onDelete() {},
      width: 68,
      onResize() {},
      onClose() {},
      onError() {},
      onNotify() {},
    }),
  );
  assert.match(html, /What will you build with artifacts\?/);
  assert.match(html, /If you can dream it, you can build it\./);
  assert.match(html, /New artifact/);
  assert.doesNotMatch(html, /Create an artifact/);
});

test("a list row says Edited, offers a pin and the grid card's menu", () => {
  const artifacts: Artifact[] = [
    {
      id: "a",
      name: "Card",
      language: "html",
      content: "<p>card</p>",
      conversationId: "c",
      sourcePath: "/w/card.html",
      updatedAt: Date.now() - 5_000,
    },
  ];
  const noop = async () => {};
  const html = renderToStaticMarkup(
    createElement(ArtifactsPage, {
      artifacts,
      onOpenArtifact() {},
      onCreate() {},
      onComment: noop,
      authorName: "Zed",
      onShareRequestConsumed() {},
      onDuplicate: noop,
      onPin: noop,
      onDelete() {},
      width: 68,
      onResize() {},
      onClose() {},
      onError() {},
      onNotify() {},
    }),
  );
  assert.match(html, /Edited just now/);
  assert.doesNotMatch(html, /Updated just now/);
  assert.match(html, /class="artifacts-row-pin" aria-pressed="false"/);
});

test("Rename artifact keeps Save off until the cleaned name differs", () => {
  const html = renderToStaticMarkup(
    createElement(RenameArtifactDialog, {
      name: "Card",
      onSave() {},
      onClose() {},
    }),
  );
  assert.match(html, /Rename artifact/);
  assert.match(html, /aria-label="Artifact name"/);
  assert.match(html, /<button class="rename-save" disabled="">Save<\/button>/);
});

test("the runtime error is a card with the original's title and button", () => {
  const html = renderToStaticMarkup(
    createElement(ArtifactRuntimeError, {
      message: "ReferenceError: x is not defined",
      onTryFix: async () => {},
      onDismiss() {},
      onError() {},
    }),
  );
  assert.match(html, /<strong>Error running artifact<\/strong>/);
  assert.match(
    html,
    /An error occurred while trying to run the generated artifact\./,
  );
  assert.match(html, /ReferenceError: x is not defined/);
  assert.match(html, /Try fixing with Claudex/);
  assert.match(html, /aria-label="Dismiss"/);
});

test("the browser's empty state is Browse the web without Browser tools", () => {
  const render = (toolsAvailable: boolean) =>
    renderToStaticMarkup(createElement(BrowserEmptyState, { toolsAvailable }));
  assert.match(render(true), /Browse with Claudex/);
  assert.match(render(false), /Browse the web/);
  assert.match(render(false), /Type a URL to open a site\./);
});

test("terminal tabs keep their opening number when another closes, and take names", () => {
  const chat = "terminal-test-chat";
  const first = tabNumber(chat, "a"),
    second = tabNumber(chat, "b"),
    third = tabNumber(chat, "c");
  assert.deepEqual([first, second, third], [1, 2, 3]);
  // One terminal is just Terminal; several are Terminal N.
  assert.equal(tabLabel(chat, "a", 1, first), "Terminal");
  assert.equal(tabLabel(chat, "b", 3, second), "Terminal 2");
  forgetTab(chat, "a");
  assert.equal(tabLabel(chat, "c", 2, tabNumber(chat, "c")), "Terminal 3");
  // A terminal opened later does not take a closed one's number.
  assert.equal(tabNumber(chat, "d"), 4);
  assert.equal(
    cleanTabName(chat, "b", "  build \u0007  watch "),
    "build watch",
  );
  assert.equal(tabLabel(chat, "b", 3, second), "build watch");
  assert.equal(cleanTabName(chat, "b", "   "), undefined);
  assert.equal(tabLabel(chat, "b", 3, second), "Terminal 2");
});
