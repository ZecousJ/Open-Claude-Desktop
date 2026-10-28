import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { parseHTML } from "linkedom";

test("current web light sidebar uses the measured half-pixel 10% ink seam", () => {
  const css = postcss.parse(
    readFileSync(
      new URL("../../src/styles/95-web.css", import.meta.url),
      "utf8",
    ),
  );
  const selector =
    ':root[data-surface="web"][data-theme="light"] .app.web .sidebar';
  const rules: string[] = [];
  css.walkRules(selector, (rule) =>
    rule.walkDecls("border-right", (d) => {
      rules.push(d.value);
    }),
  );
  assert.deepEqual(rules, ["0.5px solid rgb(11 11 11 / 10%)"]);
  for (const theme of ["light", "dark"])
    for (const surface of ["web", "desktop"]) {
      const document = parseHTML(
        `<html data-theme="${theme}" data-surface="${surface}"><body><div class="app ${surface}"><aside class="sidebar"></aside></div></body></html>`,
      ).document;
      assert.equal(
        document.querySelector("aside")!.matches(selector),
        theme === "light" && surface === "web",
      );
    }
});
