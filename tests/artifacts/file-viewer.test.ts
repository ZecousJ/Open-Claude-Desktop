import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import { preloadArtifactCard } from "../../src/artifacts/LazyArtifactCard";

// The document card loads lazily in the app; a static render needs it in.
before(() => preloadArtifactCard());
import assert from "node:assert/strict";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactPanel } from "../../src/artifacts/FileViewer";
import { highlightedLines } from "../../src/artifacts/ArtifactSource";
import { htmlDocument } from "../../src/artifacts/preview-document";
import { Markdown, renderedText } from "../../src/ui/components";

test("highlighted source retains original whitespace and multiline token spans", () => {
  const children = [
    "let a = ",
    createElement("span", { className: "hljs-string" }, '"first\nsecond"'),
    ";\n\n<script>literal</script>\n",
  ];
  const lines = highlightedLines(children);
  assert.deepEqual(lines.map(renderedText), [
    'let a = "first',
    'second";',
    "",
    "<script>literal</script>",
    "",
  ]);
  const html = renderToStaticMarkup(
    createElement(
      "div",
      {},
      lines.map((line, i) => createElement("div", { key: i }, line)),
    ),
  );
  assert.equal((html.match(/hljs-string/g) ?? []).length, 2);
  assert.match(html, /&lt;script&gt;literal/);
});

test("highlighted source gives sibling token spans distinct keys", () => {
  // TSX highlighting nests single-line spans inside a multi-line one; each
  // single-line clone is keyed 0, so they must not end up as keyed siblings.
  const children = [
    createElement(
      "span",
      { className: "xml" },
      createElement("span", { className: "hljs-tag" }, "<a>"),
      " ",
      createElement("span", { className: "hljs-tag" }, "<b>"),
      "\n",
      createElement("span", { className: "hljs-tag" }, "</a>"),
    ),
  ];
  const duplicates: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      const keys = node
        .filter(isValidElement)
        .map((element) => element.key)
        .filter((key) => key !== null);
      if (new Set(keys).size !== keys.length) duplicates.push(keys.join(","));
      node.forEach(visit);
    } else if (isValidElement<{ children?: unknown }>(node))
      visit(node.props.children);
  };
  const lines = highlightedLines(children);
  lines.forEach(visit);
  assert.deepEqual(duplicates, []);
  assert.deepEqual(lines.map(renderedText), ["<a> <b>", "</a>"]);
});

test("HTML preview preserves isolated origin and blocks external resources and forms", () => {
  const source =
    '<html><body><button onclick="this.textContent=1">0</button></body></html>';
  const html = renderToStaticMarkup(
    createElement(ArtifactPanel, {
      artifact: { id: "a", name: "Example", language: "html", content: source },
      onClose() {},
      onError() {},
    }),
  );
  assert.match(html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(
    html,
    /allow-same-origin|allow-popups|allow-top-navigation/,
  );
  assert.match(
    htmlDocument(source),
    /connect-src 'none'; form-action 'none'; base-uri 'none'/,
  );
  assert.match(html, /File view mode/);
  assert.match(html, /Resize file viewer/);
});

test("standalone HTML opens as a document card; inline code samples stay code", () => {
  const render = (text: string) =>
    renderToStaticMarkup(createElement(Markdown, { text, onArtifact() {} }));
  const html = render(
    "```html\n<!doctype html><html><head><title>Reference &lt;card&gt;</title></head><body>Test</body></html>\n```",
  );
  assert.match(html, /file-document-card/);
  assert.doesNotMatch(html, /<iframe|<html>/);
  assert.match(render("```html\n<button>Example</button>\n```"), /code-block/);
});

test("native preview documents are bounded, revocable and isolated from disk/network URLs", async () => {
  const { ArtifactPreviews, previewCsp, maxPreviewBytes } =
    await import("../../electron/artifacts/artifact-previews");
  const registry = new ArtifactPreviews();
  const url = registry.create("<p>synthetic only</p>");
  assert.match(url, /^claudex-preview:\/\/document\//);
  assert(registry.has(url));
  const response = registry.response(url);
  assert.equal(await response.text(), "<p>synthetic only</p>");
  assert.match(
    response.headers.get("Content-Security-Policy")!,
    /sandbox allow-scripts/,
  );
  assert.doesNotMatch(previewCsp, /allow-same-origin|https?:|unsafe-eval/);
  for (const invalid of [
    url + "?other=1",
    "file:///etc/passwd",
    "https://example.test",
    url + "/../x",
  ])
    assert.equal(registry.response(invalid).status, 404);
  assert.equal(registry.response(url, "POST").status, 404);
  registry.release(url);
  assert.equal(registry.response(url).status, 404);
  assert.equal(maxPreviewBytes, 32 * 1024 * 1024);
  assert.throws(
    () => registry.create("x".repeat(maxPreviewBytes + 1)),
    /32 MB/,
  );
  for (let i = 0; i < 16; i++) registry.create("test");
  assert.throws(() => registry.create("excess"), /Too many/);
  registry.clear();
  assert(registry.create("after clear"));
});
