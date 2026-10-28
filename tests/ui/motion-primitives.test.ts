import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Collapsible } from "../../src/ui/Collapsible";

test("a closed section renders nothing; an open one renders its rows open", () => {
  assert.equal(
    renderToStaticMarkup(
      createElement(Collapsible, { open: false, children: "body" }),
    ),
    "",
  );
  const html = renderToStaticMarkup(
    createElement(Collapsible, {
      open: true,
      className: "group",
      children: "body",
    }),
  );
  assert.match(html, /class="u-expand-rows group"/);
  assert.match(html, /data-open="true"/);
  assert.doesNotMatch(html, /inert/);
  assert.match(html, /<div>body<\/div>/);
});

test("the spring easing peaks near 1.09 and ends at rest", () => {
  const css = readFileSync("src/styles/00-foundation.css", "utf8");
  const body = /--ease-spring:\s*linear\(([^)]*)\)/.exec(css)?.[1];
  assert.ok(body, "--ease-spring is a linear() easing");
  const points = body.split(",").map((value) => Number(value.trim()));
  assert.equal(points[0], 0);
  assert.equal(points.at(-1), 1);
  const peak = Math.max(...points);
  assert.ok(peak > 1.08 && peak < 1.1, `peak ${peak}`);
});
