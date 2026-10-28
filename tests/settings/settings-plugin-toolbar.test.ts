import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { PluginCatalog, PluginEntry } from "../../shared/collections-api";
import { PluginsTab } from "../../src/settings/tabs/Plugins";
import { preloadMarketplaces } from "../../src/plugins/PluginsBody";

const plugin = (
  title: string,
  marketplace = "reference",
  category = "development",
): PluginEntry => ({
  id: `${title.toLowerCase()}@${marketplace}`,
  name: title.toLowerCase(),
  title,
  marketplace,
  marketplacePath: "/reference/marketplace.json",
  category,
  installed: false,
  enabled: false,
  installable: true,
  source: "git",
});

const catalog = (plugins: PluginEntry[] = []): PluginCatalog => ({
  plugins,
  marketplaces: [
    { name: "reference", path: "/reference/marketplace.json", plugins: 2 },
    { name: "second", path: "/second/marketplace.json", plugins: 1 },
  ],
  loadErrors: [],
});

async function mounted(
  node: ReactNode,
  initial: PluginCatalog,
  run: (document: Document, installed: string[]) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const installed: string[] = [];
  const desktop = {
    listPlugins: async () => initial,
    installPlugin: async (id: string) => {
      installed.push(id);
      initial = {
        ...initial,
        plugins: initial.plugins.map((entry) =>
          entry.id === id
            ? { ...entry, installed: true, enabled: true }
            : entry,
        ),
      };
      return { id, appsNeedingAuth: [] };
    },
  };
  Object.assign(window, { desktop });
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    innerWidth: 1280,
    innerHeight: 720,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const before = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  await preloadMarketplaces();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(async () => root.render(node));
    await run(document as unknown as Document, installed);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of before)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
}

const click = async (document: Document, selector: string) => {
  const button = document.querySelector<HTMLButtonElement>(selector);
  assert.ok(button, `Missing ${selector}`);
  await act(async () => button.click());
};

test("Settings Plugins uses the observed h2 and named segmented/search controls", () => {
  const { document } = parseHTML(
    renderToStaticMarkup(createElement(PluginsTab)),
  );
  assert.equal(
    document.querySelector(".plugins-settings-header h2")?.textContent,
    "Plugins",
  );
  assert.equal(document.querySelector(".plugins-settings-header h1"), null);
  assert.ok(
    document.querySelector('[role="radiogroup"][aria-label="Plugins"]'),
  );
  assert.ok(
    document.querySelector('input[type="search"][aria-label="Search"]'),
  );
  assert.ok(document.querySelector('input[placeholder="Search"]'));
  assert.equal(document.querySelector('button[aria-label="Filter"]'), null);
  assert.equal(document.querySelector('button[aria-label="Sort"]'), null);
  assert.ok(document.querySelector('button[aria-label="Add plugin"]'));
});

test("Discover retains Filter and Sort before its catalogue loads", () => {
  const { document } = parseHTML(
    renderToStaticMarkup(
      createElement(PluginsTab, { initialView: "discover" }),
    ),
  );
  for (const name of ["Filter", "Sort"])
    assert.ok(document.querySelector(`button[aria-label="${name}"]`));
  for (const name of ["Filter", "Sort", "Add"])
    assert.ok(document.querySelector(`[data-icon="${name}"][width="20"]`));
  assert.ok(document.querySelector('[data-icon="CaretDown"][width="16"]'));
});

test("Plugins toolbar measurements stay private to its lazy Settings page", () => {
  const css = readFileSync("src/plugins/plugins-settings.css", "utf8");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))![1];
  };
  assert.match(
    rule(".plugins-settings > .plugins-settings-header"),
    /min-height:\s*32px/,
  );
  assert.match(
    rule(".plugins-settings > .plugins-settings-header"),
    /padding:\s*0;/,
  );
  assert.match(rule(".plugins-settings-identity"), /gap:\s*16px/);
  assert.match(rule(".plugins-settings-identity > h2"), /font-size:\s*22px/);
  assert.match(rule(".plugins-settings-identity > h2"), /line-height:\s*28px/);
  assert.match(rule(".plugins-settings-identity > h2"), /font-weight:\s*580/);
  assert.match(rule(".plugins-settings-tools"), /gap:\s*8px/);
  assert.match(
    rule(".plugins-settings-tools > .desktop-add-button"),
    /height:\s*32px/,
  );
  assert.match(
    rule(".plugins-settings-tools > .desktop-add-button"),
    /gap:\s*4px/,
  );
  assert.match(
    rule(".plugins-settings-tools > .desktop-add-button"),
    /font-size:\s*14px/,
  );
  assert.match(
    rule(".plugins-settings-tools .settings-page-search > input"),
    /flex:\s*1/,
  );
  assert.match(
    rule(".plugins-settings-tools .settings-page-search > input"),
    /margin:\s*0;/,
  );
  assert.match(
    rule(".plugins-settings-tools .settings-page-search > input"),
    /height:\s*100%;/,
  );
  assert.match(
    rule(".plugins-settings-tools .settings-page-search"),
    /box-shadow:\s*inset 0 0 0 1px/,
  );
  assert.match(
    readFileSync("src/settings/tabs/Plugins.tsx", "utf8"),
    /import "\.\.\/\.\.\/plugins\/plugins-settings\.css"/,
  );
  assert.doesNotMatch(
    readFileSync("src/main.tsx", "utf8"),
    /plugins-settings\.css/,
  );
});

test("empty Discover opens working Filter and truthful Name-only Sort", async () => {
  await mounted(
    createElement(PluginsTab, { initialView: "discover" }),
    catalog(),
    async (document) => {
      await click(document, 'button[aria-label="Filter"]');
      assert.ok(document.querySelector('[role="menu"][aria-label="Filter"]'));
      assert.ok(
        document.querySelector('[role="menuitemradio"][aria-checked="true"]'),
      );
      await click(document, 'button[aria-label="Sort"]');
      const menu = document.querySelector('[role="menu"][aria-label="Sort"]')!;
      assert.ok(menu);
      const options = Array.from(
        menu.querySelectorAll<HTMLButtonElement>("button"),
      );
      assert.deepEqual(
        options.map((button) => button.textContent),
        ["Most installed", "Recently added", "Name"],
      );
      assert.equal(options[0].disabled, true);
      assert.equal(options[1].disabled, true);
      assert.equal(options[2].disabled, false);
      assert.match(
        options[0].title,
        /does not provide install counts or addition dates/,
      );
      assert.equal(options[2].getAttribute("aria-checked"), "true");
      await act(async () => options[2].click());
      assert.equal(document.querySelector('[role="menu"]'), null);
      const yours = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      ).find((button) => button.textContent === "Yours");
      assert.ok(yours);
      await act(async () => yours.click());
      assert.equal(document.querySelector('button[aria-label="Filter"]'), null);
      assert.equal(document.querySelector('button[aria-label="Sort"]'), null);
    },
  );
});

test("Discover sorts actual runtime plugins by name and retains category, marketplace and install actions", async () => {
  const initial = catalog([
    plugin("Zulu"),
    plugin("Beta", "second", "data"),
    plugin("Alpha"),
  ]);
  await mounted(
    createElement(PluginsTab, { initialView: "discover" }),
    initial,
    async (document, installed) => {
      const titles = () =>
        Array.from(
          document.querySelectorAll(".customize-catalogue-cards strong"),
          (node) => node.textContent,
        );
      assert.deepEqual(titles(), ["Alpha", "Beta", "Zulu"]);
      await click(document, 'button[aria-label="Filter"]');
      const data = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).find((button) => button.textContent === "Data");
      assert.ok(data);
      await act(async () => data.click());
      assert.deepEqual(titles(), ["Beta"]);
      await click(document, 'button[aria-label="Filter"]');
      const allCategories = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).find((button) => button.textContent === "All categories");
      assert.ok(allCategories);
      await act(async () => allCategories.click());
      await click(document, 'button[aria-label="Filter"]');
      const reference = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).find((button) => button.textContent === "reference");
      assert.ok(reference);
      await act(async () => reference.click());
      assert.deepEqual(titles(), ["Alpha", "Zulu"]);
      await click(document, 'button[aria-label="Add Alpha"]');
      assert.deepEqual(installed, ["alpha@reference"]);
      assert.ok(document.querySelector('button[aria-label="Added: Alpha"]'));
      await click(document, 'button[aria-label="Add plugin"]');
      assert.ok(
        document.querySelector('[role="menu"][aria-label="Add plugin"]'),
      );
      assert.ok(
        Array.from(document.querySelectorAll('[role="menuitem"]')).some(
          (node) => node.textContent?.includes("Add marketplace"),
        ),
      );
    },
  );
});
