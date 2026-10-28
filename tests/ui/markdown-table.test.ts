import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownTable, scrollsSideways } from "../../src/ui/MarkdownTable";

test("a table scrolls sideways only when it is wider than its column", () => {
  assert.equal(scrollsSideways({ scrollWidth: 800, clientWidth: 600 }), true);
  assert.equal(scrollsSideways({ scrollWidth: 600, clientWidth: 600 }), false);
  // A pixel of rounding is not overflow.
  assert.equal(scrollsSideways({ scrollWidth: 601, clientWidth: 600 }), false);
});

test("a table that fits is plain; the markup keeps the scroll classes", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownTable, null, createElement("tbody")),
  );
  assert.match(
    html,
    /^<div class="markdown-table prose-scroll u-scroll-fade-x"><table>/,
  );
  assert.ok(!html.includes("tabindex"));
});
