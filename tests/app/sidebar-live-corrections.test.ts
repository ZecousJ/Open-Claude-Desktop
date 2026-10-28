import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import { readSource } from "../support/read-source";

test("the fade belongs to the title, not the final trailing status slot", () => {
  const { document } = parseHTML(
    '<div class="app web"><a class="conversation-link"><span class="row-title-slot">Long title</span><span class="row-status-trailing"><span class="row-status"><span class="thread-dot working"></span></span></span></a></div>',
  );
  const title = document.querySelector(".row-title-slot")!;
  const status = document.querySelector(".row-status-trailing")!;
  const sheet = postcss.parse(readSource("src/sidebar/sidebar.css", "utf8"));
  let titleFade = false,
    statusFade = false;
  sheet.walkRules((rule) => {
    if (!rule.selector.startsWith(".conversation-link >")) return;
    rule.walkDecls("mask-image", (decl) => {
      assert.match(decl.value, /linear-gradient/);
      if (title.matches(rule.selector)) titleFade = true;
      if (status.matches(rule.selector)) statusFade = true;
    });
  });
  assert.equal(titleFade, true);
  assert.equal(statusFade, false);
  const source = readSource("src/sidebar/ConversationRow.tsx", "utf8");
  assert.ok(
    source.indexOf('className="row-status-trailing"') >
      source.indexOf('className="row-title-slot"'),
  );
  assert.match(source, /surface === "web" &&/);
});

test("the web Code title uses the observed titlebar inset and line box", () => {
  const sheet = postcss.parse(
    readSource("src/code-home/code-home.css", "utf8"),
  );
  const rules = new Map<string, Record<string, string>>();
  sheet.walkRules((rule) => {
    const declarations: Record<string, string> = {};
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = declaration.value;
    });
    rules.set(rule.selector, declarations);
  });
  const corner = rules.get(".app.web .web-home-corner.code-draft-corner")!;
  const title = rules.get(".app.web .web-home-corner .code-draft-title")!;
  assert.equal(corner.top, "9px");
  assert.equal(corner.left, "9px");
  assert.equal(title["padding-inline-start"], "10px");
  assert.equal(title["font-size"], "13px");
  assert.equal(title["line-height"], "19px");
  assert.equal(title["font-weight"], "500");
});

test("the clipped Code sort wrapper preserves its child's 24px hit target", () => {
  const sheet = postcss.parse(readSource("src/web/web-shell.css", "utf8"));
  const declarations: Record<string, string> = {};
  sheet.walkRules(".app.web .code-recents-sort > button", (rule) => {
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = declaration.value;
    });
  });
  assert.equal(declarations.flex, "0 0 24px");
  assert.equal(declarations.width, "24px");
  assert.equal(declarations.height, "24px");
  assert.equal(declarations.padding, "0");
  const css = readSource("src/web/web-shell.css", "utf8").replace(/\s+/g, " ");
  assert.match(css, /\.app\.web \.sidebar \{ overflow: clip; \}/);
  assert.match(css, /padding: 0 0 0 10px/);
});
