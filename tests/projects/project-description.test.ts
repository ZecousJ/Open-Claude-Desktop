import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectDescription } from "../../src/collections/projects/ProjectOverview";

test("a project's description is one paragraph of at most three lines, its line breaks kept, without Show more", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectDescription, {
      description: "First line\nSecond line",
    }),
  );
  assert.match(
    html,
    /<p class="prj-overview-description" data-no-translate="true">/,
  );
  assert.match(html, /First line\nSecond line/);
  assert.doesNotMatch(html, /Show more|Show less|<button/);
  const css = readFileSync(
    new URL(
      "../../src/collections/projects/project-overview.css",
      import.meta.url,
    ),
    "utf8",
  );
  const rule = css.match(/\.prj-overview-description \{([^}]*)\}/)![1];
  for (const declaration of [
    "margin: 8px 0 0",
    "font-size: 14px",
    "line-height: 20px",
    "white-space: pre-line",
    "-webkit-line-clamp: 3",
  ])
    assert.ok(rule.includes(declaration), declaration);
});
