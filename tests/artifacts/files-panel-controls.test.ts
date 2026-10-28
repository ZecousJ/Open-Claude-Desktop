import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { routineDom } from "../support/routine-dom";
import { FilesPanel, type FilesBridge } from "../../src/files/FilesPanel";
import { setTreePosition } from "../../src/files/tree-position";
import type { Conversation } from "../../shared/types";
const conversation: Conversation = {
  id: "synthetic-files",
  title: "Synthetic",
  mode: "code",
  cwd: "/synthetic",
  environment: { kind: "local" },
  pinned: false,
  archived: false,
  providerId: "p",
  model: "Opus",
  createdAt: 1,
  updatedAt: 1,
  turns: [],
};
const paths = ["one.bin", "two.bin", "three.bin"];
const bridge: FilesBridge = {
  listProjectFolder: async () => ({
    entries: paths.map((path) => ({ path, name: path, kind: "file" as const })),
    truncated: false,
  }),
  readProjectFile: async (path) => ({ path, binary: true, bytes: 10 }),
};
async function mount(account: string) {
  const dom = await routineDom();
  const proto = dom.window.HTMLInputElement.prototype;
  const previousSelect = Object.getOwnPropertyDescriptor(proto, "select");
  Object.defineProperty(proto, "select", { configurable: true, value() {} });
  const clean = dom.clean;
  dom.clean = async () => {
    await clean();
    if (previousSelect) Object.defineProperty(proto, "select", previousSelect);
    else Reflect.deleteProperty(proto, "select");
  };
  const render = () =>
    dom.render(
      createElement(FilesPanel, {
        conversation,
        bridge,
        accountId: account,
        onClose() {},
      }),
    );
  await render();
  const tree = (name: string) =>
    [...dom.document.querySelectorAll('[role="treeitem"]')].find(
      (e) => e.getAttribute("title") === name,
    )!;
  const tabs = () => [...dom.document.querySelectorAll('[role="tab"]')];
  const keep = async (name: string) => {
    await dom.event(tree(name), "click");
    await dom.event(tree(name), "dblclick");
  };
  return { ...dom, renderPanel: render, tree, tabs, keep };
}
test("actual file tabs preserve previews, roving traversal, ordering, IME and close focus", async () => {
  const dom = await mount("tabs-acceptance");
  try {
    await dom.event(dom.tree(paths[0]), "click");
    await dom.event(dom.tree(paths[1]), "click");
    assert.deepEqual(
      dom.tabs().map((e) => e.getAttribute("aria-label")),
      [paths[1]],
    );
    assert.equal(dom.tabs()[0].getAttribute("data-preview"), "true");
    assert.equal(
      dom.tabs()[0].closest("header"),
      dom.document.querySelector(".files-panel > header"),
    );
    assert.equal(
      dom.document.querySelector(".files-view [role=tablist]"),
      null,
    );
    assert.equal(
      dom.document.querySelector(".files-path")?.textContent,
      paths[1],
    );
    await dom.keep(paths[1]);
    await dom.keep(paths[0]);
    await dom.keep(paths[2]);
    assert.deepEqual(
      dom.tabs().map((e) => e.getAttribute("aria-label")),
      [paths[1], paths[0], paths[2]],
    );
    const tab = (path: string) =>
      dom.tabs().find((e) => e.getAttribute("aria-label") === path)!;
    await dom.event(tab(paths[2]), "keydown", { key: "Home" });
    assert.equal(tab(paths[2]).getAttribute("aria-selected"), "true");
    assert.equal(tab(paths[1]).getAttribute("aria-selected"), "false");
    assert.equal(tab(paths[1]).getAttribute("tabindex"), "0");
    await dom.event(tab(paths[1]), "keydown", { key: "Enter" });
    assert.equal(tab(paths[1]).getAttribute("aria-selected"), "true");
    assert.equal(dom.document.activeElement, tab(paths[1]));
    await dom.event(tab(paths[1]), "keydown", {
      key: "ArrowRight",
      ctrlKey: true,
      shiftKey: true,
    });
    assert.deepEqual(
      dom.tabs().map((e) => e.getAttribute("aria-label")),
      [paths[0], paths[1], paths[2]],
    );
    await dom.event(tab(paths[1]), "keydown", {
      key: "ArrowRight",
      metaKey: true,
      shiftKey: true,
    });
    assert.deepEqual(
      dom.tabs().map((e) => e.getAttribute("aria-label")),
      [paths[0], paths[2], paths[1]],
    );
    await dom.event(tab(paths[1]), "keydown", {
      key: "Delete",
      isComposing: true,
    });
    await dom.event(tab(paths[1]), "keydown", { key: "Delete", ctrlKey: true });
    await dom.event(tab(paths[1]), "keydown", { key: "Delete", repeat: true });
    assert.equal(dom.tabs().length, 3);
    await dom.event(tab(paths[1]), "keydown", { key: "ArrowLeft" });
    assert.equal(dom.document.activeElement, tab(paths[2]));
    await dom.event(tab(paths[2]), "keydown", { key: "Delete" });
    assert.equal(dom.document.activeElement, tab(paths[1]));
    assert.equal(tab(paths[1]).getAttribute("aria-selected"), "true");
    for (const close of dom.document.querySelectorAll(".files-tab-close"))
      assert.equal(close.getAttribute("tabindex"), "-1");
    await dom.event(tab(paths[1]), "keydown", { key: "Enter" });
    const active = tab(paths[1]),
      panel = dom.document.querySelector('[role="tabpanel"]')!;
    assert.equal(active.getAttribute("aria-controls"), panel.id);
    assert.equal(panel.getAttribute("aria-labelledby"), active.id);
    dom.document.documentElement.dir = "rtl";
    await dom.event(active, "keydown", { key: "ArrowLeft" });
    assert.equal(dom.document.activeElement, tab(paths[0]));
    // Removing the final focused tab must not leave a stale roving stop.
    while (dom.tabs().length) {
      const selected = dom
        .tabs()
        .find((node) => node.getAttribute("aria-selected") === "true")!;
      (selected as HTMLElement).focus();
      await dom.event(selected, "keydown", { key: "Delete" });
    }
    await dom.event(dom.tree(paths[0]), "click");
    assert.equal(dom.tabs()[0].getAttribute("tabindex"), "0");
  } finally {
    await dom.clean();
  }
});
test("file divider supports arrows, Home/End, collapse, edge opening, pointer cancel and persisted account widths", async () => {
  const dom = await mount("divider-acceptance");
  const divider = () =>
    dom.document.querySelector<HTMLElement>(
      '[role="separator"][aria-label="Resize file tree"]',
    )!;
  const width = () => Number(divider().getAttribute("aria-valuenow"));
  try {
    assert.equal(width(), 240);
    // The pane is on the conversation's right, so the tree is too (File
    // tree position Automatic): moving its divider left widens it.
    assert.ok(dom.document.querySelector(".files-body.tree-right"));
    await dom.event(divider(), "keydown", { key: "ArrowRight" });
    assert.equal(width(), 232);
    await dom.event(divider(), "keydown", { key: "ArrowLeft", shiftKey: true });
    assert.equal(width(), 264);
    await dom.event(divider(), "keydown", { key: "Home" });
    assert.equal(width(), 160);
    await dom.event(divider(), "keydown", { key: "End" });
    assert.equal(width(), 640);
    await dom.event(divider(), "keydown", { key: "ArrowLeft", ctrlKey: true });
    assert.equal(width(), 640);
    await dom.event(divider(), "keydown", { key: "Enter" });
    assert.equal(width(), 0);
    assert.equal(dom.document.querySelector(".files-tree"), null);
    await dom.event(divider(), "keydown", { key: "Enter" });
    assert.equal(width(), 640);
    // The tree on the left: dragging right widens it.
    setTreePosition("left");
    await dom.event(divider(), "focus");
    assert.equal(dom.document.querySelector(".files-body.tree-right"), null);
    await dom.event(divider(), "pointerdown", {
      button: 0,
      pointerId: 1,
      clientX: 640,
    });
    await dom.event(divider(), "pointermove", { pointerId: 1, clientX: 320 });
    assert.equal(width(), 320);
    await dom.event(divider(), "pointercancel", { pointerId: 1, clientX: 320 });
    assert.equal(width(), 640);
    await dom.event(divider(), "pointerdown", {
      button: 0,
      pointerId: 2,
      clientX: 640,
    });
    await dom.event(divider(), "pointermove", { pointerId: 2, clientX: 280 });
    await dom.event(divider(), "pointerup", { pointerId: 2, clientX: 280 });
    assert.equal(width(), 280);
    await dom.event(divider(), "pointerdown", {
      button: 0,
      pointerId: 3,
      clientX: 280,
    });
    await dom.event(divider(), "pointermove", { pointerId: 3, clientX: 40 });
    await dom.event(divider(), "pointerup", { pointerId: 3, clientX: 40 });
    assert.equal(width(), 0);
    await dom.event(divider(), "pointerdown", {
      button: 0,
      pointerId: 4,
      clientX: 0,
    });
    await dom.event(divider(), "pointermove", { pointerId: 4, clientX: 200 });
    await dom.event(divider(), "pointerup", { pointerId: 4, clientX: 200 });
    assert.equal(width(), 200);
    dom.document.documentElement.dir = "rtl";
    await dom.event(divider(), "keydown", { key: "ArrowRight" });
    assert.equal(width(), 192);
    await dom.render(createElement("p"));
    await dom.renderPanel();
    assert.equal(width(), 192);
    await dom.render(
      createElement(FilesPanel, {
        conversation,
        bridge,
        accountId: "other-account",
        onClose() {},
      }),
    );
    assert.equal(width(), 240);
  } finally {
    setTreePosition("auto");
    await dom.clean();
  }
});
test("Files header search focuses the tree filter rather than opening another dialog", async () => {
  const dom = await mount("filter-acceptance");
  try {
    const button = dom.document.querySelector(
      '[aria-label="Go to file or search"]',
    )!;
    await dom.event(button, "click");
    assert.equal(
      dom.document.activeElement,
      dom.document.querySelector('[aria-label="Filter files"]'),
    );
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    assert.ok(dom.document.querySelector('[aria-label="Files settings"] svg'));
  } finally {
    await dom.clean();
  }
});

test("an HTML file opens as its source and the eye shows it as a page", async () => {
  const dom = await routineDom({}, { jsdom: true });
  const html = "<!doctype html><h1>Hello</h1>";
  try {
    await dom.render(
      createElement(FilesPanel, {
        conversation: { ...conversation, id: "synthetic-html" },
        bridge: {
          listProjectFolder: async () => ({
            entries: [
              { path: "index.html", name: "index.html", kind: "file" as const },
            ],
            truncated: false,
          }),
          readProjectFile: async (path) => ({
            path,
            bytes: html.length,
            content: html,
          }),
        },
        accountId: "html-preview",
        onClose() {},
      }),
    );
    const item = [...dom.document.querySelectorAll('[role="treeitem"]')].find(
      (e) => e.getAttribute("title") === "index.html",
    )!;
    await dom.event(item, "click");
    for (
      let i = 0;
      i < 40 &&
      !dom.document.querySelector(
        ".files-save-bar .cm-editor, .files-content .cm-editor",
      );
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const eye = dom.document.querySelector(
      '.files-save-bar button[aria-label="Preview"]',
    );
    assert.ok(eye, "the path row has the Preview button");
    assert.equal(dom.document.querySelector(".files-content iframe"), null);
    await dom.event(eye!, "click");
    let frame: Element | null = null;
    for (let i = 0; i < 40 && !frame; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      frame = dom.document.querySelector(".files-content iframe");
    }
    assert.ok(frame, "the page shows in a frame");
    assert.equal(frame!.getAttribute("sandbox"), "allow-scripts");
    assert.ok(
      dom.document.querySelector(
        '.files-save-bar button[aria-label="View source"]',
      ),
    );
  } finally {
    await dom.clean();
  }
});
