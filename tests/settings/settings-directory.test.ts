/**
 * Settings → Design systems, Plugins and Extensions (UI first, no Claudex
 * backend): the static catalogue's helpers, what each page renders on the
 * desktop and the web, and that every action needing a service is shown
 * disabled rather than pretending to work.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "react-dom" &&
      context.parentURL?.endsWith("/src/settings/controls.tsx")
    )
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent("export const createPortal = (node) => node;"),
        shortCircuit: true,
      };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});

const { desktopHost, webHost } = await import("../../shared/host");
const { HostContext } = await import("../../src/host/HostContext");
const { tabAvailable, availableNavGroups } =
  await import("../../src/settings/nav");
const catalogue =
  await import("../../src/settings/directory/directory-helpers");
const { notAvailable } = await import("../../src/settings/unavailable");
const { DesignSystemsTab } =
  await import("../../src/settings/tabs/DesignSystems");
const { PluginsTab } = await import("../../src/settings/tabs/Plugins");
const { ExtensionsTab } = await import("../../src/settings/tabs/Extensions");

const tabProps = {
  settings: {} as never,
  save: () => {},
  platform: "darwin" as const,
  engine: {} as never,
  onError: () => {},
  goTo: () => {},
};
const render = (host: typeof desktopHost, element: ReactElement) =>
  renderToStaticMarkup(
    createElement(HostContext.Provider, { value: host }, element),
  );

test("the directory formats publication dates", () => {
  assert.equal(catalogue.formatPublished("2026-06-23"), "Jun 23, 2026");
});

test("design systems search by name", () => {
  const list = [
    {
      id: "a",
      name: "Design System",
      scope: "Standalone" as const,
      usableBy: [],
    },
    {
      id: "b",
      name: "Brand kit",
      scope: "Organization" as const,
      usableBy: [],
    },
  ];
  assert.deepEqual(
    catalogue.findDesignSystems(list, " brand ").map((s) => s.id),
    ["b"],
  );
  assert.equal(catalogue.findDesignSystems(list, "").length, 2);
});

test("Extensions is on every desktop host and never on the web", () => {
  assert.equal(tabAvailable("extensions", desktopHost, false), true);
  // A desktop host without local MCP still has the page.
  const noMcp = {
    ...desktopHost,
    capabilities: { ...desktopHost.capabilities, localMcp: false },
  };
  assert.equal(tabAvailable("extensions", noMcp, false), true);
  assert.equal(tabAvailable("developer", noMcp, false), false);
  assert.equal(tabAvailable("extensions", webHost, false), false);
  const webTabs = availableNavGroups(webHost, false).flatMap((g) =>
    g.tabs.map((t) => t.id),
  );
  assert.ok(!webTabs.includes("extensions"));
  assert.ok(webTabs.includes("plugins") && webTabs.includes("design"));
});

test("Design systems shows its header, search and an empty table", () => {
  const html = render(desktopHost, createElement(DesignSystemsTab, tabProps));
  assert.match(html, /Design systems give Claudex your colors/);
  assert.match(html, /New design system/);
  assert.match(html, /placeholder="Search by name"/);
  assert.match(html, /No design systems yet/);
  // The table is always drawn, its headers included.
  assert.match(html, /<table/);
  assert.match(html, /Usable by/);
});

test("Design systems lists records in the table", () => {
  const at = Date.UTC(2026, 5, 23, 12);
  const record = (name: string, guidelines: string) => ({
    id: name,
    name,
    blurb: "",
    notes: "",
    sources: [],
    guidelines,
    createdAt: at,
    updatedAt: at,
    ...(guidelines ? { generatedAt: at } : {}),
  });
  const html = render(
    desktopHost,
    createElement(DesignSystemsTab, {
      ...tabProps,
      settings: { designSystem: "Design System" } as never,
      systems: [record("Design System", "# Rules"), record("Draft one", "")],
    }),
  );
  assert.match(
    html,
    /<span data-no-translate="true">Design System<\/span><span class="settings-badge design-system-kind">Standalone<\/span><\/button>/,
  );
  assert.match(html, /In use/);
  assert.equal((html.match(/>Standalone<\/span>/g) ?? []).length, 2);
  assert.match(html, /title="Available only in your account\.">—<\/td>/);
  assert.match(html, /Showing 1–2 of 2/);
  assert.match(html, /Jun 23, 2026/);
  assert.match(html, /Draft/);
  assert.match(html, /Actions for Design System/);
  assert.match(html, /<th>Content written<\/th>/);
});

test("Plugins starts on Yours and loads the runtime's list", () => {
  const html = render(webHost, createElement(PluginsTab, tabProps));
  assert.match(html, /aria-checked="true"[^>]*>Yours</);
  assert.match(html, />Discover</);
  assert.match(html, /aria-label="Loading plugins"/);
  assert.match(html, /placeholder="Search"/);
  assert.match(html, /aria-haspopup="menu"[^>]*>.*Add/);
  // The filter belongs to Discover, and needs plugins to filter.
  assert.doesNotMatch(html, /Filter plugins/);
});

test("Extensions shows the empty list and, on the desktop, Advanced settings", () => {
  const desktop = render(desktopHost, createElement(ExtensionsTab, tabProps));
  assert.match(desktop, /Allow Claudex to directly interact with apps/);
  assert.match(desktop, /Browse extensions/);
  assert.match(desktop, /No extensions installed/);
  assert.match(desktop, /Advanced settings/);
  assert.match(desktop, /Drag .MCPB or .DXT files here to install/);
  const web = render(webHost, createElement(ExtensionsTab, tabProps));
  assert.match(web, /No extensions installed/);
  assert.doesNotMatch(web, /Advanced settings|Drag .MCPB/);
});

test("every action without a backend says it is not available", () => {
  assert.equal(notAvailable, "Not available in Claudex yet");
  assert.match(catalogue.extensionFilePattern.source, /mcpb\|dxt/);
});
