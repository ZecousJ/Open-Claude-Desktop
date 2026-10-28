import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../../src/ui/Markdown";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import { loadHighlight } from "../../src/ui/lazy-highlight";
import { setLocale } from "../../src/i18n";

// The document translator skips .markdown, so a code block's Copy and Open
// speak the language themselves.
before(async () => {
  await Promise.all([
    preloadMarkdownRenderer(),
    loadHighlight(),
    setLocale("zh-CN"),
  ]);
});
after(() => setLocale("en-US"));

test("a code block's copy tooltip and Open button are in the chosen language", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      text: "```js\nreturn 42;\n```",
      onArtifact() {},
    }),
  );
  assert.match(html, /role="tooltip"[^>]*>复制<\/span>/);
  assert.match(html, /<\/(span|svg)>打开<\/button>/);
});
