import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import postcss from "postcss";

// Badge variant pro, size sm: bg-tint-violet text-pro, h-control-nested 18px,
// rounded-chip a quarter of it, px-sm 6px, caption 11/17 medium.
test("the bash pill is the violet pro badge", async () => {
  const css = postcss.parse(
    await readFile(
      new URL("../../src/composer/bash-mode.css", import.meta.url),
      "utf8",
    ),
  );
  const rules = new Map<string, Map<string, string>>();
  css.walkRules((rule) => {
    const declarations = new Map<string, string>();
    rule.walkDecls((decl) => {
      declarations.set(decl.prop, decl.value);
    });
    rules.set(rule.selector, declarations);
  });
  const dark = rules.get(".bash-mode-pill")!;
  assert.equal(dark.get("height"), "18px");
  assert.equal(dark.get("padding"), "0 6px");
  assert.equal(dark.get("border-radius"), "4.5px");
  assert.equal(dark.get("background"), "#785ee81f");
  assert.equal(dark.get("color"), "#a89af0");
  assert.equal(dark.get("font-size"), "11px");
  assert.equal(dark.get("font-weight"), "500");
  assert.equal(
    rules.get(':root[data-theme="light"] .bash-mode-pill')?.get("color"),
    "#5437b8",
  );
});
