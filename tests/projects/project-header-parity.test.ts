import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import postcss, { type AtRule } from "postcss";
import { JSDOM } from "jsdom";
import { desktopHost, webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { ProjectOverview } from "../../src/collections/projects/ProjectOverview";

const project = {
  id: "project",
  name: "Example title",
  description: "User description",
  instructions: "",
  pinned: true,
  createdAt: 1,
};

test("web project actions live beside the breadcrumb and at the end of the header", () => {
  const render = (host: typeof webHost) =>
    parseHTML(
      renderToStaticMarkup(
        createElement(
          HostContext.Provider,
          { value: host },
          createElement(ProjectOverview, {
            project,
            chats: [],
            composer: null,
            menuOpen: false,
            onBack() {},
            onMenu() {},
            onSave: async () => {},
            onScheduled() {},
            onOpenConversation() {},
          }),
        ),
      ),
    ).document;
  const web = render(webHost);
  assert.equal(
    web.querySelector(".prj-crumb-back")?.getAttribute("href"),
    "/projects",
  );
  assert.ok(
    web.querySelector(
      '.prj-crumbs [aria-label="More options for Example title"]',
    ),
  );
  assert.ok(
    web.querySelector(
      '.prj-overview-header-actions [aria-label="Unpin project"]',
    ),
  );
  assert.ok(
    web.querySelector(".prj-overview-header-actions .prj-overview-search-slot"),
  );
  assert.equal(web.querySelector(".prj-overview-head button"), null);
  assert.ok(web.querySelector("h1[data-no-translate]"));
  assert.ok(web.querySelector(".prj-overview-description[data-no-translate]"));
  const desktop = render(desktopHost);
  assert.equal(desktop.querySelector(".prj-overview-topbar"), null);
  assert.ok(
    desktop.querySelector('.prj-overview-head [aria-label="Unpin project"]'),
  );
  assert.ok(
    desktop.querySelector(
      '.prj-overview-head [aria-label="Example title actions"]',
    ),
  );
});

test("project header and scroller retain the measured desktop and phone dimensions", () => {
  // Live /project/<id>, 2026-10-16: header 48px, search 32px/256px,
  // The captured hub is composer 692px, gap/overhang resolved from its
  // x312..1004 box and the 344px rail at x1060 (finding12).
  const css = readFileSync(
    new URL(
      "../../src/collections/projects/project-overview.css",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(css, /\.prj-overview-topbar\s*\{[^}]*height:\s*48px/);
  assert.match(
    css,
    /\.prj-overview-scroller\s*\{[^}]*height:\s*calc\(100% - 48px\)[^}]*scrollbar-gutter:\s*stable both-edges/,
  );
  // Render the actual overview and apply the real wide rules. Current source
  // uses a 352px rail with 344px visible rows, 62px gap and 16px overhang.
  const markup = renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      { value: webHost },
      createElement(ProjectOverview, {
        project,
        chats: [],
        composer: createElement("div", null, "Editor"),
        menuOpen: false,
        onBack() {},
        onMenu() {},
        onSave: async () => {},
        onScheduled() {},
        onOpenConversation() {},
      }),
    ),
  );
  const wideRules = postcss
    .parse(css)
    .nodes.filter((node) => node.type !== "atrule")
    .map((node) => node.toString())
    .join("\n");
  const wide = new JSDOM(
    `<html data-surface="web"><head><style>${wideRules}</style></head><body><div class="app web">${markup}</div></body></html>`,
  );
  try {
    const style = (selector: string) =>
      wide.window.getComputedStyle(
        wide.window.document.querySelector(selector)!,
      );
    assert.equal(style(".prj-overview-columns").maxWidth, "none");
    assert.equal(style(".prj-overview-columns").gap, "62px");
    assert.equal(style(".prj-overview-side").flexBasis, "352px");
    assert.equal(style(".prj-overview-composer").marginInline, "-16px");
  } finally {
    wide.window.close();
  }
  assert.match(
    css,
    /\.prj-project-search-trigger\s*\{[^}]*width:\s*32px[^}]*height:\s*32px/,
  );
  assert.match(
    css,
    /\.prj-header-search\s*\{[^}]*width:\s*256px[^}]*height:\s*32px/,
  );
  // Exercise the actual rules inside the source's <64rem breakpoint, rather
  // than requiring its obsolete max-width:1023px spelling.
  let narrow: AtRule | undefined;
  postcss.parse(css).walkAtRules("media", (rule) => {
    if (rule.params === "(width < 64rem)") narrow = rule;
  });
  assert.ok(narrow?.nodes);
  const dom = new JSDOM(
    '<html data-surface="web"><head></head><body><div class="prj-overview-body"><div class="prj-overview-columns"></div></div></body></html>',
  );
  try {
    const style = dom.window.document.createElement("style");
    style.textContent = narrow.nodes.map((node) => node.toString()).join("\n");
    dom.window.document.head.append(style);
    assert.equal(
      dom.window.getComputedStyle(
        dom.window.document.querySelector(".prj-overview-body")!,
      ).paddingTop,
      "16px",
    );
    assert.equal(
      dom.window.getComputedStyle(
        dom.window.document.querySelector(".prj-overview-columns")!,
      ).flexDirection,
      "column",
    );
  } finally {
    dom.window.close();
  }
  assert.match(
    css,
    /@media\s*\(max-width:\s*767px\)[\s\S]*?\.prj-overview-topbar\s*\{[^}]*padding-inline-start:\s*48px/,
  );
});

test("collapsed web project headers reserve the sidebar toggle and shrink search before Pin", () => {
  const css = readFileSync(
    new URL(
      "../../src/collections/projects/project-overview.css",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    css,
    /@media\s*\(min-width:\s*768px\)[\s\S]*?\.app\.web\.sidebar-hidden \.prj-overview-topbar\s*\{[^}]*padding-inline-start:\s*calc\(6px \+ 24px \+ 8px\)/,
  );
  assert.match(css, /\.prj-overview-topbar\s*\{[^}]*--prj-header-gap:\s*8px/);
  assert.match(
    css,
    /\.prj-overview-header-actions\s*\{[^}]*max-width:\s*calc\(100% - var\(--prj-header-gap\) - var\(--prj-header-gap\)\)/,
  );
  assert.match(
    css,
    /\.prj-overview-header-actions > \.prj-overview-icon\s*\{[^}]*flex-shrink:\s*0/,
  );
  assert.match(
    css,
    /\.prj-overview-topbar \.prj-overview-icon\s*\{[^}]*position:\s*relative[^}]*isolation:\s*isolate/,
  );
  assert.match(css, /\.prj-header-search\s*\{[^}]*min-width:\s*160px/);

  // Resolve the constrained flex row using the live component dimensions:
  // 48/8px phone insets, two 8px header gaps, 4px actions gap, Pin 28px.
  // This guards both the 320px clipping case and the established 390px seat.
  for (const [
    viewport,
    expectedSearchWidth,
    expectedInputWidth,
    expectedPinX,
  ] of [
    [320, 216, 145, 284],
    [390, 256, 185, 354],
  ]) {
    const start = 48;
    const end = 8;
    const headerGap = 8;
    const pin = 28;
    const actionsGap = 4;
    const actionsBudget = viewport - start - end - 2 * headerGap;
    const searchWidth = Math.min(256, actionsBudget - pin - actionsGap);
    const actionsWidth = searchWidth + pin + actionsGap;
    const searchX = viewport - end - actionsWidth;
    const pinX = searchX + searchWidth + actionsGap;
    // Field: padding 12/5, icon16, Clear22, two internal 8px gaps.
    const inputWidth = searchWidth - 12 - 5 - 16 - 22 - 2 * 8;
    assert.ok(searchWidth >= 160);
    assert.equal(searchWidth, expectedSearchWidth);
    assert.equal(inputWidth, expectedInputWidth);
    assert.equal(pinX, expectedPinX);
    assert.ok(pinX + pin <= viewport - end);
    assert.ok(inputWidth > 0);
  }
});
