import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { parseHTML } from "linkedom";
import type { CodeEffort, Provider } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog-api";

const provider: Provider = {
  id: "gateway",
  name: "Claudex",
  baseUrl: "http://localhost/v1",
  protocol: "responses",
  model: "opus-5-5",
  models: ["opus-5-5"],
};
const catalog = (efforts: string[], defaultEffort?: string): ModelCatalog => ({
  defaultModel: "opus-5-5",
  items: [
    {
      id: "opus-5-5",
      displayName: "Opus 5.5",
      description: "Actual catalog description",
      badges: [],
      sort: 0,
      hidden: false,
      isDefault: true,
      fast: false,
      usageHint: "",
      efforts: efforts as ModelCatalog["items"][number]["efforts"],
      defaultEffort:
        defaultEffort as ModelCatalog["items"][number]["defaultEffort"],
    },
  ],
});

test("web Code combines the accessible trigger and changes only catalog-supported effort radios", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    getComputedStyle: globalThis.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.innerWidth = 1440;
  window.innerHeight = 900;
  window.desktop = {
    modelCatalog: async () => catalog(["low", "high"]),
  } as never;
  let focused: HTMLElement | undefined;
  const oldFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused ?? document.body,
  });
  const frames: FrameRequestCallback[] = [];
  Object.assign(globalThis, {
    window,
    document,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
    getComputedStyle: () => ({ overflow: "visible", overflowX: "visible" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { CodeModelTrigger } =
    await import("../../src/composer/CodeModelTrigger");
  const { CodeModelMenu } =
    await import("../../src/composer/model/CodeModelMenu");
  const root = createRoot(document.querySelector("main")!);
  const changes: CodeEffort[] = [];
  let closes = 0;
  function Harness({
    initial = "low",
    request = 0,
    web = true,
  }: {
    initial?: CodeEffort;
    request?: number;
    web?: boolean;
  }) {
    const [effort, setEffort] = useState(initial),
      [open, setOpen] = useState(false);
    return createElement(
      "div",
      null,
      createElement(CodeModelTrigger, {
        model: "opus-5-5",
        effort,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: () => setOpen(!open),
      }),
      open &&
        createElement(CodeModelMenu, {
          providers: [provider],
          providerId: "gateway",
          model: "opus-5-5",
          onSelect: assert.fail,
          onManage: assert.fail,
          onClose: () => {
            closes++;
            setOpen(false);
          },
          sessionEffort: web
            ? {
                value: effort,
                openRequest: request,
                onChange: (value) => {
                  changes.push(value);
                  setEffort(value);
                },
              }
            : undefined,
        }),
    );
  }
  const flush = async () => {
    await act(async () => {
      while (frames.length) frames.shift()!(0);
    });
  };
  const key = async (target: Element, value: string) => {
    const event = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(event, { key: value });
    await act(async () => target.dispatchEvent(event));
    await flush();
  };
  const click = async (target: Element) => {
    await act(async () =>
      target.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    await flush();
  };
  try {
    await act(async () => root.render(createElement(Harness, {})));
    const trigger = document.querySelector<HTMLButtonElement>(
      ".web-code-model-trigger",
    )!;
    assert.equal(trigger.getAttribute("aria-label"), "Model: Opus 5.5 Low");
    trigger.focus();
    await click(trigger);
    assert.equal(
      document.querySelector(".code-session-model-heading")?.textContent,
      "Model · this session",
    );
    const effort = document.querySelector("[data-code-effort]")!;
    await key(effort, "ArrowRight");
    let rows = Array.from(
      document.querySelectorAll('.code-session-effort [role="menuitemradio"]'),
    );
    assert.deepEqual(
      rows.map((row) => row.querySelector("span")?.textContent),
      ["Low", "High"],
    );
    assert.equal(focused, rows[0]);
    await key(rows[0], "ArrowDown");
    assert.equal(focused, rows[1]);
    await key(rows[1], "Escape");
    assert.equal(document.querySelector(".code-session-effort"), null);
    assert.equal(focused, effort);
    assert.equal(closes, 0);
    await click(effort);
    rows = Array.from(
      document.querySelectorAll('.code-session-effort [role="menuitemradio"]'),
    );
    await click(rows[1]);
    assert.deepEqual(changes, ["high"]);
    assert.equal(closes, 1);
    assert.equal(trigger.getAttribute("aria-label"), "Model: Opus 5.5 High");
    assert.equal(focused, trigger);
    assert.equal(document.querySelector(".code-model-menu"), null);

    // A menu opened by /effort initially focuses the selected supported row.
    window.desktop.modelCatalog = async () =>
      catalog(["medium", "max"], "medium");
    await act(async () =>
      root.render(
        createElement(Harness, {
          key: "request",
          initial: "medium",
          request: 1,
        }),
      ),
    );
    const nextTrigger = document.querySelector<HTMLButtonElement>(
      ".web-code-model-trigger",
    )!;
    nextTrigger.focus();
    await click(nextTrigger);
    rows = Array.from(
      document.querySelectorAll('.code-session-effort [role="menuitemradio"]'),
    );
    assert.deepEqual(
      rows.map((row) => row.querySelector("span")?.firstChild?.textContent),
      ["Medium", "Max", "Ultracode"],
    );
    assert.equal(rows[0].querySelector("small")?.textContent, "Default");
    assert.equal(
      rows[1].querySelector("small"),
      null,
      "Max carries no invented multiplier; its usage warning is the tooltip",
    );
    assert.equal(focused, rows[0]);
    // Root consumes an Effort request when Model is invoked while this
    // same popup is mounted; closing the panel must not require remounting.
    await act(async () =>
      root.render(
        createElement(Harness, {
          key: "request",
          initial: "medium",
          request: 0,
        }),
      ),
    );
    await flush();
    assert.equal(document.querySelector(".code-session-effort"), null);
    assert.equal(focused?.getAttribute("role"), "menuitemradio");
    assert.equal(
      focused?.closest('[role="menu"]'),
      document.querySelector(".code-model-menu"),
    );
    await click(document.querySelector("[data-code-effort]")!);
    rows = Array.from(
      document.querySelectorAll('.code-session-effort [role="menuitemradio"]'),
    );
    await key(rows[0], "Escape");
    await key(document.querySelector("[data-code-effort]")!, "Escape");
    assert.equal(document.querySelector(".code-model-menu"), null);

    // Existing native/running callers omit sessionEffort and keep the old menu.
    await act(async () =>
      root.render(createElement(Harness, { key: "native", web: false })),
    );
    await click(document.querySelector(".web-code-model-trigger")!);
    assert.equal(document.querySelector(".code-session-model-heading"), null);
    assert.equal(document.querySelector("[data-code-effort]"), null);
    assert.ok(document.querySelector("[data-more-models]"));
    assert.equal(
      document.querySelectorAll(
        '.code-model-menu .code-model-quick[data-shown] button[role="menuitemradio"]',
      ).length,
      1,
    );
  } finally {
    await act(async () => root.unmount());
    window.HTMLElement.prototype.focus = oldFocus;
    Object.assign(globalThis, previous);
  }
});
