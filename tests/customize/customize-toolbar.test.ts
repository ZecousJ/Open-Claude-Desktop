import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";
import { defaultSettings } from "../../electron/store/store";

const props = {
  settings: defaultSettings,
  onUseSkill() {},
  onOpenSettings() {},
  onConfirmRemove() {},
  onError(error: unknown) {
    throw error;
  },
};

test("Customize Discover names its section tabs, view radios and toolbar actions", () => {
  const { document } = parseHTML(
    renderToStaticMarkup(createElement(CustomizePage, props)),
  );
  const tabs = document.querySelector('[role="tablist"]')!;
  assert.equal(tabs.getAttribute("aria-label"), "Customize sections");
  assert.deepEqual(
    Array.from(tabs.querySelectorAll('[role="tab"]'), (tab) => tab.textContent),
    ["Skills", "Connectors", "Plugins"],
  );
  const views = document.querySelector('.customize-views[role="radiogroup"]')!;
  assert.equal(views.getAttribute("aria-label"), "Skills");
  assert.deepEqual(
    Array.from(views.querySelectorAll('[role="radio"]'), (radio) => [
      radio.textContent,
      radio.getAttribute("aria-checked"),
      radio.getAttribute("tabindex"),
    ]),
    [
      ["Yours", "false", "-1"],
      ["Discover", "true", "0"],
    ],
  );
  for (const label of ["Search", "Filter", "Sort", "Add skill"])
    assert.ok(
      document.querySelector(`.customize-tools button[aria-label="${label}"]`),
    );
});

test("Customize view radios switch with arrow keys and a search opens the generic field", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  Object.defineProperty(window, "location", {
    value: new URL("http://127.0.0.1/customize-toolbar"),
    configurable: true,
  });
  window.desktop = {
    async customizeSkills() {
      return [];
    },
    async mcpServers() {
      return { servers: [] };
    },
    async listPlugins() {
      return { marketplaces: [], plugins: [], loadErrors: [] };
    },
    async listApprovedDirectory() {
      return [];
    },
    onEvent: () => () => {},
  } as never;
  const globals = {
    window,
    document,
    innerWidth: 1280,
    innerHeight: 720,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
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
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(async () => {
      root.render(createElement(CustomizePage, props));
    });
    const radio = () =>
      document.querySelector('.customize-views [aria-checked="true"]')!;
    assert.equal(radio().textContent, "Discover");
    const press = async (key: string) => {
      const event = new window.Event("keydown", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "key", { value: key });
      await act(async () => {
        radio().dispatchEvent(event);
      });
    };
    await press("ArrowLeft");
    assert.equal(radio().textContent, "Yours");
    assert.equal(radio().getAttribute("tabindex"), "0");
    await press("End");
    assert.equal(radio().textContent, "Discover");
    await press("ArrowDown");
    assert.equal(radio().textContent, "Yours");
    await press("Home");
    assert.equal(radio().textContent, "Yours");
    await press("ArrowRight");
    assert.equal(radio().textContent, "Discover");
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '.customize-tools [aria-label="Search"]',
        )!
        .click();
    });
    const search = document.querySelector<HTMLInputElement>(
      ".customize-search input",
    )!;
    assert.equal(search.getAttribute("aria-label"), "Search");
    assert.equal(search.getAttribute("placeholder"), "Search");
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '.customize-search [aria-label="Clear search"]',
        )!
        .click();
    });
    assert.equal(document.querySelector(".customize-search input"), null);
    // Locate by visible text: tabs do not need implementation-specific IDs.
    const pluginTab = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((tab) => tab.textContent === "Plugins")!;
    await act(async () => pluginTab.click());
    assert.ok(document.querySelector('.customize-tools [aria-label="Filter"]'));
    const sort = document.querySelector<HTMLButtonElement>(
      '.customize-tools [aria-label="Sort"]',
    )!;
    assert.ok(sort, "empty runtime catalog retains the observed Sort trigger");
    await act(async () => sort.click());
    const choices = Array.from(
      document.querySelectorAll('[role="menuitemradio"]'),
    );
    assert.deepEqual(
      choices.map((choice) => [
        choice.textContent?.trim(),
        choice.hasAttribute("disabled"),
        choice.getAttribute("aria-checked"),
      ]),
      [
        ["Most installed", true, "false"],
        ["Recently added", true, "false"],
        ["Name", false, "true"],
      ],
    );
    for (const choice of choices.slice(0, 2))
      assert.match(choice.getAttribute("title") ?? "", /does not provide/);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
