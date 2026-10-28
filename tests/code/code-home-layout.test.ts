import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { desktopHost, webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { CodeHome } from "../../src/code-home/CodeHome";
import { CodeHomeEnvironmentSlot } from "../../src/code-home/CodeHomeEnvironmentSlot";
import { EnvironmentStartCard } from "../../src/composer/EnvironmentStartCard";

const rows = [
  { id: "one", name: "One", onSelect() {} },
  { id: "two", name: "Two", onSelect() {} },
];

test("environment cards render inline without a home provider and wait while its slot is mounting", () => {
  const card = createElement(EnvironmentStartCard, {
    rows,
    selectedId: "one",
    open: false,
    onChoose() {},
  });
  assert.match(renderToStaticMarkup(card), /start-card-environments/);
  assert.equal(
    renderToStaticMarkup(
      createElement(CodeHomeEnvironmentSlot.Provider, { value: null }, card),
    ),
    "",
  );
});

test("web and native home portal their environment cards into distinct captured stacks", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML(
    '<html><body><main id="root"></main></body></html>',
  );
  window.desktop = {
    probeImportableCliSessions: async () => ({ count: 0 }),
  } as never;
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  let selections = 0;
  let focusRequests = 0;
  let chosen: HTMLButtonElement | undefined;
  try {
    await act(async () =>
      root.render(
        createElement(
          HostContext.Provider,
          { value: webHost },
          createElement(CodeHome, {
            name: "Ada",
            conversations: [],
            composer: createElement(
              "div",
              { className: "code-composer" },
              createElement(EnvironmentStartCard, {
                rows: [rows[0], { ...rows[1], onSelect: () => selections++ }],
                selectedId: "one",
                open: false,
                onChoose: (button) => {
                  chosen = button;
                },
                onRequestComposerFocus: () => focusRequests++,
              }),
              createElement("textarea", { "aria-label": "Prompt" }),
            ),
          }),
        ),
      ),
    );
    const slot = document.querySelector(".code-home-environments")!;
    const card = slot.querySelector(".environment-start-card");
    assert.ok(card);
    assert.equal(
      document.querySelector(".code-composer .environment-start-card"),
      null,
    );
    assert.ok(document.querySelector(".code-composer textarea"));
    assert.equal(
      document.querySelectorAll(".environment-start-card").length,
      1,
    );
    const choose = slot.querySelector('[data-testid="start-card-choose"]')!;
    await act(async () =>
      choose.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.equal(chosen, choose);
    await act(async () =>
      slot
        .querySelector('button[data-testid="start-card-environment"]')!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.equal(selections, 1);
    assert.equal(focusRequests, 1);

    await import("../../src/code-home/NativeCliImportCard");
    await act(async () =>
      root.render(
        createElement(
          HostContext.Provider,
          { value: desktopHost },
          createElement(CodeHome, {
            name: "Ada",
            conversations: [],
            composer: createElement(
              "div",
              { className: "code-composer" },
              createElement(EnvironmentStartCard, {
                rows,
                selectedId: "one",
                open: false,
                onChoose() {},
              }),
            ),
            landing: createElement(
              "section",
              { "data-landing": true },
              "Sessions",
            ),
          }),
        ),
      ),
    );
    assert.equal(document.querySelector(".usage-overview"), null);
    assert.ok(
      document.querySelector(
        ".native-code-home-environments .environment-start-card",
      ),
    );
    assert.equal(
      document.querySelector(".code-composer .environment-start-card"),
      null,
    );
    assert.equal(document.querySelector("[data-landing]"), null);
    assert.equal(document.querySelector(".code-home-environments"), null);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});
