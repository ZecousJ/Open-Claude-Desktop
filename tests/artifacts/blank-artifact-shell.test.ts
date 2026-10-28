import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import postcss from "postcss";
import { JSDOM } from "jsdom";
import { windowRole } from "../../src/conversation-window/window-role";
import { readSource } from "../support/read-source";
const read = (file: string) =>
  readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
function shellExpressions() {
  const source = ts.createSourceFile(
    "app/App.tsx",
    readSource("src/app/App.tsx"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let mount = "",
    hidden = "";
  const walk = (node: ts.Node) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(source) === "AppSidebar"
    ) {
      let parent: ts.Node | undefined = node;
      while (parent && !ts.isJsxExpression(parent)) parent = parent.parent;
      if (
        parent &&
        ts.isJsxExpression(parent) &&
        parent.expression &&
        ts.isBinaryExpression(parent.expression)
      )
        mount = parent.expression.left.getText(source);
    }
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === "className" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isTemplateExpression(node.initializer.expression) &&
      node.initializer.expression.head.text === "app "
    )
      hidden =
        node.initializer.expression.templateSpans[0].expression.getText(source);
    ts.forEachChild(node, walk);
  };
  walk(source);
  assert.ok(
    mount && hidden,
    "execute the actual App shell conditions, not a separate test copy",
  );
  const evaluate = (
    expression: string,
    flags: {
      sidebar: boolean;
      incognitoShown: boolean;
      conversationWindow: boolean;
      projectWindow: boolean;
      page: string;
    },
  ) =>
    Function(
      ...Object.keys(flags),
      `return (${expression})`,
    )(...Object.values(flags));
  return {
    mount: (flags: Parameters<typeof evaluate>[1]) => evaluate(mount, flags),
    hidden: (flags: Parameters<typeof evaluate>[1]) => evaluate(hidden, flags),
  };
}
test("actual App main-shell conditions retain the sidebar on an Artifact route; secondary roles remain isolated", () => {
  const expressions = shellExpressions();
  for (const page of ["chat", "artifact", "artifacts", "code"]) {
    for (const search of [
      "",
      "?window=conversation&id=paired",
      "?window=project&id=owned",
    ]) {
      const role = windowRole(search),
        flags = {
          sidebar: true,
          incognitoShown: false,
          conversationWindow: role.kind === "conversation",
          projectWindow: role.kind === "project",
          page,
        };
      assert.equal(
        expressions.mount(flags),
        role.kind === "main",
        `${role.kind}/${page}`,
      );
      assert.equal(
        expressions.hidden(flags),
        role.kind === "main" ? "" : "sidebar-hidden",
        `${role.kind}/${page}`,
      );
      assert.equal(
        expressions.hidden({ ...flags, sidebar: false }),
        "sidebar-hidden",
      );
      assert.equal(
        expressions.hidden({ ...flags, incognitoShown: true }),
        "sidebar-hidden",
      );
    }
  }
});
test("actual native/web CSS cascade removes the generic 760px cap only from full-page blank panes", () => {
  const sheets = [
    "styles/40-panels.css",
    "styles/92-reference-panels.css",
    "artifacts/file-viewer.css",
    "artifacts/blank-artifact.css",
  ].map(read);
  for (const host of ["darwin host-desktop", "web host-web"]) {
    const dom = new JSDOM(
      `<html><head></head><body><div class="app ${host}"><aside class="sidebar"></aside><main class="workspace"><aside id="full" class="artifact-panel artifact-collaboration blank-artifact-panel" data-standalone="true"></aside><aside id="dock" class="artifact-panel artifact-collaboration blank-artifact-panel"></aside><aside id="other" class="work-panel"></aside></main></div></body></html>`,
    );
    try {
      const style = dom.window.document.createElement("style");
      // Top-level desktop rules keep the real order/selectors/declarations.
      // Layout is checked by Root in the real browser, not JSDOM's box model.
      style.textContent = sheets
        .map((sheet) =>
          postcss
            .parse(sheet)
            .nodes.filter((node) => node.type === "rule")
            .map((node) => node.toString())
            .join("\n"),
        )
        .join("\n");
      dom.window.document.head.append(style);
      const full = dom.window.getComputedStyle(
          dom.window.document.getElementById("full")!,
        ),
        dock = dom.window.getComputedStyle(
          dom.window.document.getElementById("dock")!,
        ),
        other = dom.window.getComputedStyle(
          dom.window.document.getElementById("other")!,
        );
      assert.equal(full.maxWidth, "none", host);
      assert.equal(full.minWidth, "0px", host);
      assert.equal(full.width, "100%", host);
      assert.equal(full.margin, "0px", host);
      assert.equal(dock.maxWidth, "760px", host);
      assert.equal(other.maxWidth, "760px", host);
    } finally {
      dom.window.close();
    }
  }
});
