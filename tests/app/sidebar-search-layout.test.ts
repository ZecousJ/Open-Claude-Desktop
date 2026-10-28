import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const { Sidebar } = await import("../../src/sidebar/Sidebar");
const { ShortcutPlatform } = await import("../../src/ui/Tooltip");
const { NavTemplateIcon, navCreatePosition } =
  await import("../../src/sidebar/NavCreateMenu");

const noop = () => {};
const props: ComponentProps<typeof Sidebar> = {
  onToggleSidebar: noop,
  conversations: [],
  approvalIds: new Set(),
  page: "chat",
  mode: "chat",
  onNewChat: noop,
  onPageChange: noop,
  onEditSidebar: noop,
  onSearch: noop,
  onSettings: noop,
  onUsage: noop,
  onChangelog: noop,
  projects: [],
  rowActions: {
    onOpen: noop,
    onRename: noop,
    onMoveToProject: noop,
    onToggleArchive: noop,
    onDelete: noop,
    onToggleUnread: noop,
    onOpenIn: noop,
  },
  onReorder: async () => {},
  onError: noop,
  settingsName: "Fixture user",
};

const render = (platform: string) =>
  parseHTML(
    renderToStaticMarkup(
      createElement(
        ShortcutPlatform.Provider,
        { value: platform },
        createElement(Sidebar, props),
      ),
    ),
  ).document;

test("current web sidebar search field has the platform command-palette hint", () => {
  const mac = render("darwin");
  const search = mac.querySelector(".web-sidebar-search")!;
  assert.equal(
    search.querySelector("span:last-of-type")?.textContent,
    "Search",
  );
  assert.equal(search.querySelector("kbd")?.textContent, "⌘ K");
  assert.equal(
    search.querySelector("kbd")?.getAttribute("aria-hidden"),
    "true",
  );
  assert.equal(
    render("win32").querySelector(".web-sidebar-search kbd")?.textContent,
    "Ctrl K",
  );
});

test("web Recents keeps View all beside its filter even with no records", () => {
  const document = render("darwin");
  const heading = document.querySelector(".recent-label")!;
  assert.ok(heading.querySelector('button[aria-label="View all"]'));
  assert.ok(
    heading.querySelector('button[aria-label="Filter and group recents"]'),
  );
  assert.equal(heading.querySelectorAll(".recents-search").length, 0);
  assert.equal(document.querySelectorAll(".view-all").length, 0);
  assert.equal(document.querySelectorAll(".account-search").length, 0);
});

test("Code footer receives the active chat-page session and clears it on collection pages", () => {
  const conversation = {
    id: "synthetic-code",
    title: "Synthetic Code",
    mode: "code",
    pinned: false,
    archived: false,
    providerId: "fixture",
    model: "Opus",
    turns: [],
    createdAt: 1,
    updatedAt: 1,
  } as const;
  const footer = (page: string) =>
    parseHTML(
      renderToStaticMarkup(
        createElement(Sidebar, {
          ...props,
          page,
          mode: "code",
          activeConversation: conversation as never,
        }),
      ),
    ).document.querySelector(
      '.reason-wrapper:has([aria-label="Send feedback"])',
    )!;
  // The reason sits in a focusable wrapper's hidden description.
  const reason = (page: string) =>
    footer(page).querySelector(":scope > .sr-only")?.textContent;
  assert.equal(reason("chat"), "Feedback isn’t available for this session.");
  assert.equal(reason("artifacts"), "Open a session to send feedback.");
});

test("template menu kinds render their actual 16px official glyph in a labelled tint tile", () => {
  for (const [kind, name] of [
    ["Docs", "File"],
    ["Slides", "Slides"],
    ["Design", "Palette"],
    ["Dashboard", "ChartLine"],
  ] as const) {
    const document = parseHTML(
      renderToStaticMarkup(createElement(NavTemplateIcon, { kind })),
    ).document;
    const tile = document.querySelector(".nav-template-icon")!;
    assert.equal(tile.getAttribute("data-template"), kind);
    assert.equal(tile.getAttribute("aria-hidden"), "true");
    const glyph = tile.querySelector(".app-icon")!;
    assert.equal(glyph.getAttribute("data-icon"), name);
    assert.equal(glyph.getAttribute("width"), "16");
  }
});

test("phone Search keeps one page inset instead of nesting two margins", async () => {
  const css = await readFile(
    new URL("../../src/styles/95-web.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.app\.web \.sidebar \{[^}]*border-right: 0;/s);
  assert.match(css, /\.app\.web \.sidebar-body \{\s*padding-top: 8px;/);
  assert.match(
    css,
    /\.app\.web \.sidebar \.web-sidebar-search \{[^}]*margin: 0 0 4px;/s,
  );
  assert.match(
    css,
    /\.app\.web \.sidebar \.web-sidebar-search \.app-icon \{\s*width: 20px;\s*height: 20px;/,
  );
});

test("sidebar Search opens the default fitted palette", async () => {
  const source = await readFile(
    new URL("../../src/app/AppSidebar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /onSearch=\{\(\) => \{\s*app\.setSearchEntrypoint\("default"\)/,
  );
});

test("Code's desktop sidebar: Search has Chat's hover and focus, the edge is a theme colour", async () => {
  const css = await readFile(
    new URL("../../src/code-home/native-code-home.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.mode-code \.web-sidebar-search:hover \{\s*background: var\(--fill-ghost-hover\)/,
  );
  assert.match(
    css,
    /\.mode-code \.web-sidebar-search:focus-visible \{[^}]*var\(--sidebar-focus-ring\)/s,
  );
  assert.match(
    css,
    /\.sidebar \{[^}]*border-right: 0\.5px solid var\(--border\);/s,
  );
  assert.ok(!css.includes("#2a2a2a"));
  assert.match(
    css,
    /\.mode-code:not\(\.sidebar-hidden\) \.sidebar-resize-handle \{\s*top: 0;\s*bottom: 0;\s*left: calc\(var\(--sidebar-width\) - 6px\);/,
  );
  // Pressing Search does not take the focus from the draft, as in Chat.
  const sidebar = await readFile(
    new URL("../../src/sidebar/Sidebar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    sidebar,
    /className="web-sidebar-search"\s*onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/,
  );
});

test("template popups choose the available side and align to the row action", () => {
  assert.deepEqual(
    navCreatePosition({ left: 251.5, right: 275.5, top: 161 }, 240, 1440),
    { left: 279.5, top: 161 },
  );
  assert.deepEqual(
    navCreatePosition({ left: 342, right: 378, top: 197 }, 240, 390),
    { left: 98, top: 197 },
  );
  assert.deepEqual(
    navCreatePosition({ left: 272, right: 308, top: 197 }, 240, 320),
    { left: 28, top: 197 },
  );
});
