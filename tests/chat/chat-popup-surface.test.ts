import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postcss from "postcss";

test("the current Chat popup uses measured CDS ink/ring/drop shadow without changing legacy menus", () => {
  const css = postcss.parse(
    readFileSync("src/composer/composer-add-menu.css", "utf8"),
  );
  const found: Record<string, string> = {};
  css.walkRules((rule) => {
    if (
      !rule.selector.includes(
        ":is(.composer-add-web-chat, .composer-add-native-chat)",
      )
    )
      return;
    assert.match(rule.selector, /:root:not\(\[data-theme="light"\]\)/);
    assert.equal(rule.selector.includes(".composer-add-submenu"), false);
    rule.walkDecls((d) => {
      found[d.prop] = d.value;
    });
  });
  assert.equal(found.color, "#f0efec");
  assert.match(found["box-shadow"], /inset 0 0 0 1px #ffffff1a/);
  assert.match(found["box-shadow"], /0 8px 24px rgba\(0, 0, 0, 0\.32\)/);
  assert.match(found["box-shadow"], /0 2px 6px rgba\(0, 0, 0, 0\.2\)/);
});

test("Invite keeps the source Button's natural translated label width", () => {
  const css = postcss.parse(
    readFileSync("src/conversation/chat-share.css", "utf8"),
  );
  const declarations: Record<string, string> = {};
  css.walkRules((rule) => {
    if (rule.selector.trim() !== ".chat-share-invite > button") return;
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = declaration.value;
    });
  });
  assert.equal(declarations.width, "auto");
  assert.equal(declarations.padding, "0 12px");
  assert.equal(declarations["white-space"], "nowrap");
  assert.equal(declarations.height, "32px");
});
