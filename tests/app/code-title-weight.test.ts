import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import postcss from "postcss";

const declarations = async (file: string, selector: string, prop: string) => {
  const css = postcss.parse(
    await readFile(new URL(`../../src/${file}`, import.meta.url), "utf8"),
  );
  const found: string[] = [];
  css.walkRules((rule) => {
    if (rule.selector !== selector) return;
    rule.walkDecls(prop, (decl) => {
      found.push(decl.value);
    });
  });
  return found;
};

test("a web Code title stays font-medium, where Chat's title is 400", async () => {
  // Chat's combined title button on the web.
  assert.deepEqual(
    await declarations(
      "styles/95-web.css",
      ':root[data-surface="web"] .chat-header .thread-title',
      "font-weight",
    ),
    ["400"],
  );
  // A web Code session's Rename button: "truncate text-body font-medium
  // font-control text-primary select-none".
  assert.deepEqual(
    await declarations(
      "web/web-shell.css",
      ".app.web .chat-header.code-header .thread-rename-trigger",
      "font-weight",
    ),
    ["500"],
  );
});
