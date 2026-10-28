import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";
import { HostContext } from "../../src/host/HostContext";
import { hostFor, type HostSurface } from "../../shared/host";
import { defaultSettings } from "../../electron/store/store";
import type { CustomizeSkill } from "../../shared/collections-api";
import { setLocale } from "../../src/i18n";
import { startDomTranslation } from "../../src/i18n/dom";

const bundled = (name: string, editedAt: number): CustomizeSkill => ({
  name,
  description: `${name} description`,
  path: `/bundled/${name}/SKILL.md`,
  scope: "system",
  enabled: true,
  own: false,
  editedAt,
});

async function renderYours(
  surface: HostSurface,
  skills: CustomizeSkill[],
  inspect: (
    document: Document,
    click: (selector: string) => Promise<void>,
  ) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.desktop = {
    customizeSkills: async () => skills,
    mcpServers: async () => ({ servers: [] }),
    listPlugins: async () => ({
      plugins: [],
      marketplaces: [],
      loadErrors: [],
    }),
    listApprovedDirectory: async () => [],
  } as never;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    right: 32,
    bottom: 32,
    left: 0,
    width: 32,
    height: 32,
    toJSON() {},
  });
  const globals = {
    window,
    document,
    MutationObserver: window.MutationObserver,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    innerWidth: 1440,
    innerHeight: 900,
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
  const click = async (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    assert.ok(button, selector);
    await act(async () => button.click());
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          HostContext.Provider,
          {
            value: hostFor(surface),
          },
          createElement(CustomizePage, {
            settings: defaultSettings,
            onUseSkill() {},
            onOpenSettings() {},
            onConfirmRemove() {},
            onError(error: unknown) {
              throw error;
            },
          }),
        ),
      ),
    );
    await click('.customize-views [role="radio"]');
    await inspect(document as unknown as Document, click);
  } finally {
    await act(() => root.unmount());
    // Let the actual document translator finish its removal observation.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("Yours keeps the current view segment and gives empty cards and rows explicit semantics", async () => {
  await renderYours(
    "web",
    [bundled("zeta", 2), bundled("alpha", 1)],
    async (document) => {
      assert.equal(
        document.querySelector('.customize-views [aria-checked="true"]')
          ?.textContent,
        "Yours",
      );
      assert.equal(
        document.querySelector(".customize-yours-callout h3")?.textContent,
        "Add your first skills",
      );
      assert.equal(
        document.querySelector(".customize-yours-callout strong"),
        null,
      );
      assert.ok(
        document.querySelector(
          '.customize-tools [aria-label="Sort by Last edited"]',
        ),
      );
      assert.ok(document.querySelector('button[aria-label="View zeta"]'));
      assert.equal(
        document.querySelectorAll(
          '.customize-yours .customize-row-tile [data-icon="Scroll"]',
        ).length,
        2,
      );
      assert.ok(
        document.querySelector('button[aria-label="More actions for zeta"]'),
      );
      assert.equal(
        document.querySelector(".customize-yours .customize-section h3")
          ?.firstChild?.textContent,
        "From Claudex & Partners",
      );
      assert.equal(
        document.querySelectorAll(".customize-row-text [data-no-translate]")
          .length,
        4,
      );
      assert.match(
        document.querySelector(".customize-yours")!.textContent!,
        /from Claudex/,
      );
    },
  );
});

test("Yours Name sort changes actual row order and its accessible label", async () => {
  await renderYours(
    "web",
    [bundled("zeta", 2), bundled("alpha", 1)],
    async (document, click) => {
      const names = () =>
        Array.from(
          document.querySelectorAll(".customize-yours .customize-row-main"),
          (row) => row.getAttribute("aria-label"),
        );
      assert.deepEqual(names(), ["View zeta", "View alpha"]);
      await click('.customize-tools [aria-label="Sort by Last edited"]');
      assert.ok(
        document.querySelector(
          '[role="menu"][aria-label="Sort by Last edited"]',
        ),
      );
      const name = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).find((button) => button.textContent === "Name")!;
      assert.ok(name);
      await act(async () => name.click());
      assert.deepEqual(names(), ["View alpha", "View zeta"]);
      assert.ok(
        document.querySelector('.customize-tools [aria-label="Sort by Name"]'),
      );
    },
  );
});

test("web Plugins Yours omits the nonfunctional project folder shelf and preserves the existing desktop entry", async () => {
  for (const surface of ["web", "desktop"] as const)
    await renderYours(surface, [], async (document, click) => {
      const plugins = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '.customize-tabs [role="tab"]',
        ),
      ).find((button) => button.textContent === "Plugins")!;
      assert.ok(plugins);
      await act(async () => plugins.click());
      assert.equal(
        document.querySelector(".customize-yours-callout h3")?.textContent,
        "Add your first plugins",
      );
      const text = document.querySelector(".customize-scroll")!.textContent!;
      assert.equal(text.includes("Open folder…"), surface === "desktop");
      assert.match(text, /Build for the Claudex Directory/);
      assert.equal(
        document.querySelector('.customize-tools [aria-label="Filter"]'),
        null,
      );
      assert.equal(
        document.querySelector('.customize-tools [aria-label="Sort"]'),
        null,
      );
    });
});

test("disabled skill badges follow Chinese and English while user names and descriptions remain literal", async () => {
  await setLocale("en-US");
  await renderYours(
    "web",
    [
      { ...bundled("Off", 2), enabled: false, description: "Settings" },
      { ...bundled("weekly-notes", 1), enabled: false, description: "Off" },
    ],
    async (document) => {
      startDomTranslation();
      try {
        for (const [locale, expected] of [
          ["en-US", "Off"],
          ["zh-CN", "关闭"],
          ["en-US", "Off"],
        ]) {
          await act(async () => {
            await setLocale(locale);
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
          const rows = Array.from(
            document.querySelectorAll(".customize-yours .customize-row"),
          );
          assert.equal(rows.length, 2);
          assert.equal(
            rows[0].querySelector("strong")?.firstChild?.textContent,
            "Off",
            locale,
          );
          assert.equal(
            rows[1].querySelector("strong")?.firstChild?.textContent,
            "weekly-notes",
            locale,
          );
          assert.deepEqual(
            rows.map(
              (row) => row.querySelector(".customize-badge")?.textContent,
            ),
            [expected, expected],
            locale,
          );
          assert.deepEqual(
            rows.map(
              (row) =>
                row.querySelector(".customize-row-line > [data-no-translate]")
                  ?.textContent,
            ),
            ["Settings", "Off"],
            locale,
          );
        }
      } finally {
        await act(async () => {
          await setLocale("en-US");
        });
      }
    },
  );
});
