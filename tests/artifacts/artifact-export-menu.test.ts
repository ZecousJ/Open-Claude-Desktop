import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import {
  ArtifactExportMenu,
  ArtifactVersionMenu,
} from "../../src/artifacts/ArtifactExportMenu";

test("the generic artifact host exports via Download and version history recalls the chosen version", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: () => ({ getPropertyValue: () => "8" }),
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let downloads = 0;
  const versions: number[] = [];
  const click = (element: Element) =>
    act(async () => {
      element.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
  try {
    await act(async () =>
      root.render(
        createElement(ArtifactExportMenu, {
          onDownload: () => {
            downloads++;
          },
        }),
      ),
    );
    await click(document.querySelector('button[aria-haspopup="menu"]')!);
    const menu = document.querySelector('[role="menu"]')!;
    assert.equal(menu.textContent?.replace(/[\uE000-\uF8FF]/g, ""), "Download");
    assert.doesNotMatch(
      menu.textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      /Word|PDF|Google Docs|Notion/,
    );
    await click(menu.querySelector("button")!);
    assert.equal(downloads, 1);
    await act(async () =>
      root.render(
        createElement(ArtifactVersionMenu, {
          count: 3,
          shown: 2,
          onChoose: (version) => {
            versions.push(version);
          },
        }),
      ),
    );
    const trigger = document.querySelector('button[aria-haspopup="menu"]')!;
    assert.equal(
      trigger.textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      "Version history3",
    );
    assert.equal(
      trigger.getAttribute("aria-label"),
      "Version history, 3 versions",
    );
    await click(trigger);
    assert.ok(document.querySelector('[role="menu"][data-versions]'));
    const choices = [...document.querySelectorAll('[role="menuitemradio"]')];
    assert.deepEqual(
      choices.map((choice) =>
        choice.textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      ),
      ["Version 3", "Version 2", "Version 1"],
    );
    assert.deepEqual(
      choices.map((choice) => choice.getAttribute("aria-checked")),
      ["false", "true", "false"],
    );
    await click(choices[2]);
    assert.deepEqual(versions, [1]);
    assert.equal(document.querySelector('[role="menu"]'), null);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("document hosts expose exactly Word, PDF, Markdown and the writable connected clouds", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  let probes = 0;
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      artifactDocumentConnectors: async () => {
        probes++;
        return [
          { server: "drive", service: "gdrive" },
          { server: "notes", service: "notion" },
        ];
      },
    },
  });
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: () => ({ getPropertyValue: () => "8" }),
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const choices: unknown[] = [];
  const props = {
    onDownload: () => choices.push("download"),
    document: true,
    onDocumentExport: (format: string) => choices.push(format),
    onCloudExport: (connector: unknown) => choices.push(connector),
  };
  const click = async (button: Element) =>
    act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
  const open = async () => {
    await click(document.querySelector('button[aria-haspopup="menu"]')!);
    return [...document.querySelectorAll('[role="menu"] button')];
  };
  try {
    await act(async () =>
      root.render(createElement(ArtifactExportMenu, props)),
    );
    let buttons = await open();
    assert.deepEqual(
      buttons.map((button) =>
        button.textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      ),
      [
        "Download",
        "Word (.docx)",
        "PDF (.pdf)",
        "Markdown (.md)",
        "Google Docs",
        "Notion",
      ],
    );
    await click(buttons[1]);
    assert.deepEqual(choices, ["docx"]);
    buttons = await open();
    await click(buttons[4]);
    assert.deepEqual(choices.at(-1), { server: "drive", service: "gdrive" });
    await act(async () =>
      root.render(createElement(ArtifactExportMenu, { ...props, busy: true })),
    );
    buttons = await open();
    assert.ok(buttons.every((button) => button.hasAttribute("disabled")));
    assert.equal(probes, 1);
    await act(async () =>
      root.render(
        createElement(ArtifactExportMenu, { ...props, document: false }),
      ),
    );
    assert.equal(
      document
        .querySelector('[role="menu"]')
        ?.textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      "Download",
    );
    assert.equal(probes, 1);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
