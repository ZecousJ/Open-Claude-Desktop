import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, useState, useEffect } from "react";
import { routineDom } from "../support/routine-dom";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { CodeWorkspaceLayout } from "../../src/app/CodeWorkspaceLayout";
import { ToolDock } from "../../src/app/ToolDock";
import { usePaneExpandToggle } from "../../src/app/pane-expand";
import type { DockPanel } from "../../src/app/useToolPanels";
import { codePaneStateKey } from "../../src/app/code-pane-state";

test("actual native hosts keep dirty leaf DOM mounted through moves, fill and keyboard split", async () => {
  const dom = await routineDom();
  const storage = new Map<string, string>();
  const values = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    ResizeObserver: class {
      constructor(private run: () => void) {}
      observe() {
        this.run();
      }
      disconnect() {}
    },
    innerWidth: 1200,
    innerHeight: 800,
  };
  const descriptors = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const proto = dom.window.HTMLElement.prototype;
  const width = Object.getOwnPropertyDescriptor(proto, "clientWidth"),
    height = Object.getOwnPropertyDescriptor(proto, "clientHeight"),
    box = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
  const capture = Object.getOwnPropertyDescriptor(proto, "setPointerCapture");
  Object.defineProperty(proto, "setPointerCapture", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(proto, "clientWidth", {
    configurable: true,
    get: () => 1200,
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get: () => 800,
  });
  proto.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 1200,
    bottom: 800,
    width: 1200,
    height: 800,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  });
  let mounts = 0;
  function Card({ id }: { id: DockPanel }) {
    const [expanded, setExpanded] = useState(false);
    usePaneExpandToggle(id, () => setExpanded((v) => !v));
    useEffect(() => {
      mounts++;
    }, []);
    return h(
      "aside",
      { className: `work-panel ${id}-panel${expanded ? " expanded" : ""}` },
      h(
        "header",
        null,
        h("strong", null, id),
        h(
          "button",
          {
            "aria-label": expanded ? "Collapse" : "Expand",
            onClick: () => setExpanded((v) => !v),
          },
          "expand",
        ),
      ),
      h("textarea", {
        "aria-label": `${id} dirty draft`,
        defaultValue: "keep synthetic edit",
      }),
    );
  }
  let panels: DockPanel[] = ["files", "changes"];
  const app = {
    accountId: "pane-a",
    active: { id: "s", mode: "code" },
    toolPanels: { dock: panels },
    windowRole: { kind: "main" },
    report() {},
  } as unknown as AppController;
  const render = () =>
    dom.render(
      h(
        AppContext.Provider,
        { value: app },
        h(CodeWorkspaceLayout, {
          header: h("header", { className: "chat-header" }, "Chat"),
          main: h("div", { className: "chat-main" }),
          panels: h(ToolDock, {
            panels,
            accountId: app.accountId,
            card: (id) => h(Card, { id: id as DockPanel }),
          }),
        }),
      ),
    );
  const files = () =>
    dom.document.querySelector<HTMLElement>('[data-code-tile="files"]')!;
  const expand = () =>
    files().querySelector('[aria-label="Expand"], [aria-label="Collapse"]')!;
  const button = (label: string) =>
    dom.document.querySelector(`[aria-label="${label}"]`) ??
    [...dom.document.querySelectorAll("button")].find((node) =>
      node.textContent?.trim().endsWith(label),
    )!;
  const open = () => dom.event(expand(), "contextmenu", { detail: 1 });
  try {
    await render();
    assert.equal(mounts, 2);
    const editor = files().querySelector("textarea")!;
    editor.value = "unsaved synthetic value";
    await open();
    await dom.event(button("Move to left"), "click");
    await open();
    await dom.event(button("Move to top"), "click");
    assert.equal(files().querySelector("textarea"), editor);
    assert.equal(editor.value, "unsaved synthetic value");
    assert.equal(mounts, 2);
    assert.ok(
      dom.document.querySelector(
        '[aria-label="Resize Files and Chat, Changes"]',
      ),
    );
    await open();
    await dom.event(button("Fill"), "click");
    assert.equal(
      dom.document
        .querySelector('[data-code-tile="chat"]')
        ?.getAttribute("data-hidden"),
      "true",
    );
    assert.equal(files().querySelector("textarea"), editor);
    await dom.event(expand(), "keydown", { key: "ArrowDown" });
    await dom.event(button("Tile"), "click");
    assert.equal(
      dom.document
        .querySelector('[data-code-tile="chat"]')
        ?.getAttribute("data-hidden"),
      null,
    );
    const move = files().querySelector('[aria-label="Move"]')!;
    await dom.event(move, "keydown", { key: "ArrowLeft", nativeEvent: {} });
    assert.ok(dom.document.querySelector(".code-drop-feedback"));
    await dom.event(move, "keydown", { key: "Escape", nativeEvent: {} });
    assert.equal(dom.document.querySelector(".code-drop-feedback"), null);
    await dom.event(move, "keydown", { key: "ArrowLeft", nativeEvent: {} });
    await dom.event(move, "keydown", { key: "Enter", nativeEvent: {} });
    assert.equal(mounts, 2);
    assert.equal(files().querySelector("textarea"), editor);
    assert.ok(storage.get(codePaneStateKey("pane-a", "s"))?.includes("files"));
    panels = ["changes"];
    app.toolPanels.dock = panels;
    await render();
    panels = ["changes", "files"];
    app.toolPanels.dock = panels;
    await render();
    assert.equal(mounts, 3);
    assert.ok(files());
    const movedEditor = files().querySelector("textarea");
    const handle = files().querySelector('[aria-label="Move"]')!;
    await dom.event(handle, "pointerdown", {
      button: 0,
      pointerId: 9,
      clientX: 150,
      clientY: 16,
    });
    await dom.event(handle, "lostpointercapture", { pointerId: 9 });
    await dom.event(dom.window as never, "pointermove", {
      pointerId: 9,
      clientX: 1000,
      clientY: 785,
    });
    assert.ok(dom.document.querySelector(".code-drop-feedback"));
    await dom.event(dom.window as never, "pointerup", {
      pointerId: 9,
      clientX: 1000,
      clientY: 785,
    });
    assert.notEqual(files().style.top, "9px");
    assert.equal(files().querySelector("textarea"), movedEditor);
    let attempts = 0,
      closed = 0,
      errors = 0;
    app.report = () => {
      errors++;
    };
    app.toolPanels.close = () => {
      closed++;
    };
    dom.window.desktop.openToolPaneWindow = async () => {
      attempts++;
      throw Error("synthetic window refusal");
    };
    await open();
    await dom.event(button("Open in new window"), "click");
    assert.equal(attempts, 1);
    assert.equal(errors, 1);
    assert.equal(closed, 0);
    assert.ok(files());
    let resume: (() => void) | undefined;
    const guard = (event: Event) => {
      event.preventDefault();
      resume = (event as CustomEvent).detail.resume;
    };
    dom.window.addEventListener("claudex-before-file-navigation", guard);
    await open();
    await dom.event(button("Open in new window"), "click");
    assert.ok(resume);
    assert.equal(attempts, 1);
    assert.equal(closed, 0);
    // Keeping edits does not invoke the deferred action or open any window.
    dom.window.removeEventListener("claudex-before-file-navigation", guard);
    let acknowledge!: () => void;
    dom.window.desktop.openToolPaneWindow = () =>
      new Promise<void>((done) => {
        attempts++;
        acknowledge = done;
      });
    await open();
    await dom.event(button("Open in new window"), "click");
    app.accountId = "pane-b";
    await render();
    await act(async () => acknowledge());
    assert.equal(closed, 0);
    assert.ok(files());
    const expected = JSON.parse(
      storage.get(codePaneStateKey("pane-a", "s"))!,
    ).layout;
    panels = [];
    app.toolPanels.dock = panels;
    app.toolPanels.setPanel = (value) => {
      assert.equal(typeof value, "string");
      if (typeof value !== "string") return;
      panels = [...panels, value as DockPanel];
      app.toolPanels.dock = panels;
    };
    app.accountId = "pane-a";
    await render();
    await render();
    assert.deepEqual([...panels].sort(), ["changes", "files"]);
    assert.deepEqual(
      JSON.parse(storage.get(codePaneStateKey("pane-a", "s"))!).layout,
      expected,
    );
  } finally {
    await dom.clean();
    for (const [key, value] of descriptors) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    for (const [key, value] of [
      ["clientWidth", width],
      ["clientHeight", height],
      ["getBoundingClientRect", box],
      ["setPointerCapture", capture],
    ] as const) {
      if (value) Object.defineProperty(proto, key, value);
      else Reflect.deleteProperty(proto, key);
    }
  }
});
