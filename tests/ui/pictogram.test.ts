import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Pictogram } from "../../src/ui/Pictogram";

test("a pictogram is a glyph on its disc at the size asked for", () => {
  const html = renderToStaticMarkup(
    createElement(Pictogram, { name: "ObjectMagnifier", size: 64 }),
  );
  assert.match(html, /^<svg class="pictogram" width="64" height="64"/);
  assert.match(html, /<circle class="pictogram-highlight"/);
  assert.match(html, /lucide-search/);
});
