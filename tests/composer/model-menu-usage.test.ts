import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import type {
  ModelCatalog,
  ModelCatalogItem,
} from "../../shared/model-catalog-api";
import type { Provider, Settings } from "../../shared/types";
import { ModelMenu } from "../../src/composer/model/ModelMenu";

const item = (
  id: string,
  extra: Partial<ModelCatalogItem> = {},
): ModelCatalogItem => ({
  id,
  displayName: id,
  description: "Actual catalog description",
  badges: [],
  sort: 0,
  hidden: false,
  isDefault: true,
  usageHint: "",
  efforts: ["low", "high", "max"],
  defaultEffort: "high",
  ...extra,
});

async function environment(
  run: (env: {
    document: Document;
    render(model: string, catalog: ModelCatalog | null): Promise<void>;
    effortRows(): HTMLButtonElement[];
    choose(index: number): Promise<void>;
    selected: Settings["effort"][];
    closes(): number;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.innerWidth = 1440;
  window.innerHeight = 900;
  let catalog: ModelCatalog | null = null;
  let refresh: (() => void) | undefined;
  window.desktop = {
    modelCatalog: async () => catalog,
    onEvent: (listener: (event: { type: string }) => void) => {
      refresh = () => listener({ type: "service-changed" });
      return () => {
        refresh = undefined;
      };
    },
  } as never;
  let focused: HTMLElement | undefined;
  const focus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 100,
    y: 300,
    top: 300,
    left: 100,
    bottom: 600,
    right: 395,
    width: 295,
    height: 300,
    toJSON() {},
  });
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused ?? document.body,
  });
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    getComputedStyle: () => ({ overflow: "visible", overflowX: "visible" }),
    requestAnimationFrame: () => 1,
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
  const selected: Settings["effort"][] = [];
  let closes = 0;
  try {
    await run({
      document,
      render: async (model, next) => {
        catalog = next;
        const provider: Provider = {
          id: "actual-provider",
          name: "Actual configured provider",
          baseUrl: "http://127.0.0.1:1/v1",
          protocol: "responses",
          model,
          models: next?.items.map((entry) => entry.id) ?? [model],
        };
        await act(async () => {
          root.render(
            createElement(ModelMenu, {
              providers: [provider],
              providerId: provider.id,
              model,
              effort: "high",
              onSelect: assert.fail,
              onManage: assert.fail,
              onEffort: (value) => selected.push(value),
              onClose: () => {
                closes++;
              },
            }),
          );
        });
        // Refresh the real service hook after changing its catalog. This
        // also covers a menu retained through a catalog/model change.
        await act(async () => {
          refresh?.();
        });
        const trigger = document.querySelector<HTMLButtonElement>(
          '[data-branch="effort"]',
        )!;
        if (trigger.getAttribute("aria-expanded") !== "true")
          await act(async () => trigger.click());
      },
      effortRows: () => [
        ...document.querySelectorAll<HTMLButtonElement>(
          '.effort-submenu [role="menuitemradio"]',
        ),
      ],
      choose: async (index) => {
        const rows = document.querySelectorAll<HTMLButtonElement>(
          '.effort-submenu [role="menuitemradio"]',
        );
        assert.ok(rows[index]);
        await act(async () => rows[index].click());
      },
      selected,
      closes: () => closes,
    });
  } finally {
    await act(async () => root.unmount());
    window.HTMLElement.prototype.focus = focus;
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
}

test("Max never invents a warning or multiplier without catalog warning metadata", async () => {
  await environment(async ({ document, render, effortRows }) => {
    for (const model of [
      "claude-opus-5-5",
      "gpt-supported-max",
      "other-supported-max",
    ]) {
      for (const usageHint of ["", "   "]) {
        await render(model, {
          defaultModel: model,
          items: [item(model, { usageHint })],
        });
        assert.equal(effortRows().length, 3);
        assert.equal(document.querySelector("[data-model-usage]"), null);
        assert.equal(document.querySelector(".model-effort-badge.usage"), null);
        assert.doesNotMatch(
          document.body.textContent!,
          /High usage|1\.5×|or more usage/,
        );
      }
    }
    await render("unlisted-model", null);
    assert.equal(document.querySelector("[data-model-usage]"), null);
    assert.doesNotMatch(document.body.textContent!, /High usage|1\.5×/);
  });
});

test("actual model usage hints remain model notes for Anthropic and other providers", async () => {
  await environment(
    async ({ document, render, effortRows, choose, selected, closes }) => {
      for (const [model, usageHint] of [
        ["claude-opus-5-5", "High usage"],
        ["gpt-supported-max", "Actual provider: 2 credits per request"],
        ["other-supported-max", "Lower usage than the larger model"],
      ]) {
        await render(model, {
          defaultModel: model,
          items: [item(model, { usageHint })],
        });
        const note = document.querySelector("[data-model-usage]")!;
        assert.equal(note.textContent, usageHint);
        assert.equal(note.getAttribute("data-model-usage"), model);
        assert.equal(note.closest(".effort-submenu"), null);
        assert.equal(document.querySelector(".model-effort-badge.usage"), null);
        assert.deepEqual(
          effortRows().map((row) => row.firstElementChild?.textContent),
          ["Low", "HighDefault", "Max"],
        );
      }
      await choose(2);
      assert.deepEqual(selected, ["max"]);
      assert.equal(closes(), 1);
    },
  );
});

test("model notes neither add unsupported efforts nor leak another model's hint", async () => {
  await environment(async ({ document, render, effortRows }) => {
    const catalog: ModelCatalog = {
      defaultModel: "limited-model",
      items: [
        item("limited-model", {
          efforts: ["low", "high"],
          usageHint: "  Actual model usage note  ",
        }),
        item("different-model", { usageHint: "A different model's usage" }),
      ],
    };
    await render("limited-model", catalog);
    assert.equal(
      document.querySelector("[data-model-usage]")?.textContent,
      "Actual model usage note",
    );
    assert.deepEqual(
      effortRows().map((row) => row.firstElementChild?.textContent),
      ["Low", "HighDefault"],
    );
    await render("unlisted-model", catalog);
    assert.equal(document.querySelector("[data-model-usage]"), null);
    assert.doesNotMatch(
      document.body.textContent!,
      /A different model's usage|Actual model usage note/,
    );
    await render("limited-model", {
      ...catalog,
      items: catalog.items.map((entry) => ({ ...entry, usageHint: "" })),
    });
    assert.equal(document.querySelector("[data-model-usage]"), null);
  });
});
