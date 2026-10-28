import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import { parse as selectors, type Selector } from "css-what";
import { readSource } from "../support/read-source";

const read = (name: string) =>
  readSource(new URL(`../../src/${name}`, import.meta.url), "utf8");
// The native sidebar sheet is awaited after eager styles, so it must remain
// last here. These are real CSS/DOM cascade assertions; pointer hit testing
// is separately accepted in root's native browser inspection.
const paths = [
  "styles/10-chrome-navigation.css",
  "styles/20-workspace.css",
  "sidebar/sidebar.css",
  "incognito/incognito.css",
  "sidebar/native-chat-sidebar.css",
];
const sheets = paths.map((name) => postcss.parse(read(name)));

// Same specificity accounting as chat-phone-parity.test.ts: :not/:is/:has
// contribute their most specific argument, while :where contributes zero.
function rank(tokens: Selector[]): number {
  return tokens.reduce((sum, token) => {
    if (token.type === "attribute")
      return sum + (token.name === "id" ? 10000 : 100);
    if (token.type === "tag" || token.type === "pseudo-element") return sum + 1;
    if (token.type !== "pseudo" || token.name === "where") return sum;
    if (["is", "not", "has"].includes(token.name) && Array.isArray(token.data))
      return sum + Math.max(0, ...token.data.map(rank));
    return sum + 100;
  }, 0);
}
function mediaMatches(query: string) {
  return postcss.list.comma(query).some((alternative) => {
    for (const match of alternative.matchAll(
      /\((min|max)-(width|height):\s*([\d.]+)px\)/g,
    )) {
      const size = match[2] === "width" ? 1440 : 900;
      if (
        match[1] === "min" ? size < Number(match[3]) : size > Number(match[3])
      )
        return false;
    }
    return !/\(pointer:\s*coarse\)|\(hover:\s*none\)/.test(alternative);
  });
}
function winner(element: Element, property: string, sources = sheets) {
  let result: { value: string; selector: string; priority: number } | undefined;
  for (const sheet of sources)
    sheet.walkRules((rule) => {
      for (
        let parent:
          | postcss.AtRule
          | postcss.Rule
          | postcss.Root
          | postcss.Document
          | undefined = rule.parent;
        parent;
        parent = parent.parent
      ) {
        if (parent.type !== "atrule") continue;
        if (parent.name === "container" || /keyframes/.test(parent.name))
          return;
        if (parent.name === "media" && !mediaMatches(parent.params)) return;
      }
      for (const selector of postcss.list.comma(rule.selector)) {
        if (/::/.test(selector)) continue;
        let matches = false;
        try {
          matches = element.matches(
            selector.replace(
              /:(hover|focus-visible|focus-within|focus|active)(?![\w-])/g,
              ":not(*)",
            ),
          );
        } catch {}
        if (!matches) continue;
        const specificity = Math.max(...selectors(selector).map(rank));
        rule.walkDecls(property, (declaration) => {
          const priority = specificity + (declaration.important ? 1000000 : 0);
          if (!result || result.priority <= priority)
            result = { value: declaration.value, selector, priority };
        });
      }
    });
  return result;
}
function fixture({
  platform = "darwin",
  web = false,
  code = false,
  hidden = true,
  incognito = false,
  light = false,
} = {}) {
  const classes = [
    "app",
    platform,
    web ? "web" : "desktop",
    code ? "mode-code" : "mode-chat",
    hidden && "sidebar-hidden",
    incognito && "incognito-app",
  ]
    .filter(Boolean)
    .join(" ");
  const document = parseHTML(
    `<html data-theme="${light ? "light" : "dark"}"><body><div class="${classes}"><aside class="sidebar"></aside><div class="workspace"><button>Actual target seat</button></div></div></body></html>`,
  ).document;
  return {
    app: document.querySelector(".app")!,
    workspace: document.querySelector(".workspace")!,
  };
}

test("mac native incognito keeps its column-one workspace out of the late hidden sidebar's zero-width column", () => {
  for (const light of [false, true]) {
    const { app, workspace } = fixture({ incognito: true, light });
    const grid = winner(app, "grid-template-columns")!;
    assert.equal(grid.value, "minmax(0, 1fr)");
    assert.equal(
      grid.selector,
      ".app:not(.web).mode-chat.incognito-app.sidebar-hidden",
    );
    assert.equal(grid.priority, 500);
    assert.equal(winner(workspace, "grid-column")?.value, "1");
    // Prove the test detects the observed production regression even when
    // the old low-specificity .app.incognito-app rule remains present.
    const withoutFix = sheets.map((sheet, index) => {
      const copy = sheet.clone();
      if (paths[index] === "incognito/incognito.css")
        copy.walkRules((rule) => {
          if (
            rule.selector.includes(
              ".app:not(.web).incognito-app.sidebar-hidden",
            )
          )
            rule.remove();
        });
      return copy;
    });
    assert.equal(
      winner(app, "grid-template-columns", withoutFix)?.value,
      "0 minmax(0, 1fr)",
    );
  }
});

test("other native platforms keep the same incognito single-column workspace", () => {
  for (const platform of ["win32", "linux"])
    for (const light of [false, true]) {
      const { app, workspace } = fixture({ platform, incognito: true, light });
      assert.equal(
        winner(app, "grid-template-columns")?.value,
        "minmax(0, 1fr)",
      );
      // The Chat frame is the same on every desktop platform, so its incognito
      // rule wins there too.
      assert.equal(
        winner(app, "grid-template-columns")?.selector,
        ".app:not(.web).mode-chat.incognito-app.sidebar-hidden",
      );
      assert.equal(winner(workspace, "grid-column")?.value, "1");
    }
});

test("ordinary native collapsed and expanded Chat keep their existing two-column grid contracts", () => {
  for (const hidden of [false, true]) {
    const { app, workspace } = fixture({ hidden });
    assert.equal(
      winner(app, "grid-template-columns")?.value,
      hidden ? "0 minmax(0, 1fr)" : "var(--sidebar-width) minmax(0, 1fr)",
    );
    assert.equal(winner(workspace, "grid-column")?.value, "2");
    assert.equal(
      winner(app, "grid-template-columns")?.selector.includes("incognito"),
      false,
    );
  }
});

test("native Code and web grids retain their existing host-specific rules", () => {
  for (const hidden of [false, true]) {
    const code = fixture({ code: true, hidden });
    assert.equal(
      winner(code.app, "grid-template-columns")?.value,
      hidden
        ? "0 minmax(0, 1fr)"
        : "calc(var(--sidebar-width) + 8px) minmax(0, 1fr)",
    );
    assert.equal(winner(code.workspace, "grid-column")?.value, "2");
    const web = fixture({ web: true, hidden });
    assert.equal(
      winner(web.app, "grid-template-columns")?.value,
      hidden ? "0 minmax(0, 1fr)" : "var(--sidebar-width) minmax(0, 1fr)",
    );
    assert.equal(winner(web.workspace, "grid-column")?.value, "2");
  }
  const incognito = fixture({ web: true, incognito: true });
  assert.equal(
    winner(incognito.app, "grid-template-columns")?.value,
    "minmax(0, 1fr)",
  );
  assert.equal(
    winner(incognito.app, "grid-template-columns")?.selector,
    ".app.web.incognito-app.sidebar-hidden",
  );
  assert.equal(winner(incognito.workspace, "grid-column")?.value, "1");
});
