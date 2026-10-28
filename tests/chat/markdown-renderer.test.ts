import assert from "node:assert/strict";
import test, { before } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MarkdownRenderer,
  preloadMarkdownRenderer,
  type MarkdownRendererProps,
} from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());

const render = (props: MarkdownRendererProps) =>
  renderToStaticMarkup(createElement(MarkdownRenderer, props));

test("the lazy reply preset keeps GFM and CJK punctuation support", () => {
  const html = render({
    preset: "reply",
    children:
      "**加粗。**后文\n\n~~removed~~\n\n| a | b |\n| - | - |\n| 1 | 2 |",
  });
  assert.match(html, /<strong>加粗。<\/strong>后文/);
  assert.match(html, /<del>removed<\/del>/);
  assert.match(html, /<table>/);
});

test("plain code renderers do not gain the announcement GFM preset", () => {
  assert.doesNotMatch(render({ children: "~~source~~" }), /<del>/);
  assert.match(
    render({ preset: "gfm", children: "~~source~~" }),
    /<del>source<\/del>/,
  );
});

test("the lazy renderer preserves caller components and extra plugins", () => {
  const html = render({
    preset: "reply",
    children: "before",
    remarkPlugins: [
      () => (tree: { children: { children?: { value: string }[] }[] }) => {
        tree.children[0].children![0].value = "after";
      },
    ],
    components: { p: ({ children }) => createElement("aside", {}, children) },
  });
  assert.match(html, /<aside>after<\/aside>/);
});
