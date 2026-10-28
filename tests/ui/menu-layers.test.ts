import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { Menu, type MenuEntry } from "../../src/ui/Menu";
import { Modal } from "../../src/ui/Controls";
import { useDismiss } from "../../src/ui/useDismiss";

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
});

type Boxes = (element: Element) => ReturnType<typeof box> | undefined;

async function environment(boxes: Boxes = () => undefined) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  document.documentElement.dataset.motion = "reduced";
  const globals = {
    window,
    document,
    innerWidth: 1440,
    innerHeight: 900,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout,
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
  const prototype = window.HTMLElement.prototype;
  const focus = Object.getOwnPropertyDescriptor(prototype, "focus");
  const rect = Object.getOwnPropertyDescriptor(
    prototype,
    "getBoundingClientRect",
  );
  prototype.focus = function () {};
  prototype.getBoundingClientRect = function () {
    return boxes(this) ?? box(0, 0, 0, 0);
  };
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const render = async (element: ReturnType<typeof createElement> | null) => {
    await act(async () => {
      root.render(element);
    });
  };
  const event = async (
    target: Element | Document,
    type: string,
    values: Record<string, unknown> = {},
  ) => {
    const next = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(next, values);
    await act(async () => {
      target.dispatchEvent(next);
    });
    return next;
  };
  const escape = () => event(document, "keydown", { key: "Escape" });
  const clean = async () => {
    await act(async () => root.unmount());
    if (focus) Object.defineProperty(prototype, "focus", focus);
    else Reflect.deleteProperty(prototype, "focus");
    if (rect) Object.defineProperty(prototype, "getBoundingClientRect", rect);
    else Reflect.deleteProperty(prototype, "getBoundingClientRect");
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return { document, render, event, escape, clean };
}

const entries: MenuEntry[] = [
  {
    label: "Move to group",
    submenu: [{ label: "Work" }, { label: "Home" }],
  },
  { label: "Rename" },
];

const menu = (onClose: () => void, extra = {}) =>
  createElement(Menu, {
    label: "Row",
    entries,
    position: { left: 100, top: 100 },
    width: 180,
    onClose,
    ...extra,
  });

async function openSubmenu(page: Awaited<ReturnType<typeof environment>>) {
  const row = page.document.querySelector('[data-index="0"]')!;
  await page.event(row, "click");
}

test("Escape closes the submenu alone, then the menu", async () => {
  const page = await environment();
  let closed = 0;
  try {
    await page.render(menu(() => closed++));
    await openSubmenu(page);
    assert.ok(page.document.querySelector("[data-submenu]"));
    await page.escape();
    assert.equal(closed, 0, "the first Escape leaves the menu open");
    assert.equal(page.document.querySelector("[data-submenu]"), null);
    assert.ok(page.document.querySelector('[role="menu"]'));
    await page.escape();
    assert.equal(closed, 1);
  } finally {
    await page.clean();
  }
});

test("Escape in a menu inside a dialog leaves the dialog open", async () => {
  const page = await environment();
  let dialog = 0,
    popover = 0;
  const Popover = () => {
    useDismiss([], true, () => popover++);
    return createElement("p", { id: "popover" }, "Popover");
  };
  const show = (open: boolean) =>
    page.render(
      createElement(Modal, {
        title: "Share",
        onClose: () => dialog++,
        children: open ? createElement(Popover) : null,
      }),
    );
  try {
    await show(false);
    // The menu opens after the dialog, so it is the innermost layer.
    await show(true);
    await page.escape();
    assert.deepEqual([popover, dialog], [1, 0]);
  } finally {
    await page.clean();
  }
});

test("a dialog whose action is pending ignores Escape and the backdrop", async () => {
  const page = await environment();
  let closes = 0;
  const show = (pending: boolean) =>
    page.render(
      createElement(Modal, {
        title: "Delete",
        pending,
        onClose: () => closes++,
        children: createElement("p", {}, "Sure?"),
      }),
    );
  try {
    await show(true);
    await page.escape();
    await page.event(page.document.querySelector(".overlay")!, "mousedown");
    assert.equal(closes, 0);
    await show(false);
    await page.escape();
    assert.equal(closes, 1);
  } finally {
    await page.clean();
  }
});

test("a submenu near the window's right edge opens on the parent's left", async () => {
  const page = await environment((element) => {
    if (element.matches("[data-submenu]")) return box(0, 0, 160, 80);
    if (element.matches('[data-index="0"]')) return box(1264, 104, 172, 24);
    if (element.matches(".menu")) return box(1260, 100, 180, 80);
    return undefined;
  });
  try {
    await page.render(menu(() => {}, { position: { left: 1260, top: 100 } }));
    await openSubmenu(page);
    const sub = page.document.querySelector<HTMLElement>("[data-submenu]")!;
    // Its right edge sits 2px before the parent's left edge (1260 - 2).
    assert.equal(parseFloat(sub.style.left), 1260 - 2 - 160);
  } finally {
    await page.clean();
  }
});

test("a submenu that would run past the bottom moves up inside the window", async () => {
  const page = await environment((element) => {
    if (element.matches("[data-submenu]")) return box(0, 0, 160, 300);
    if (element.matches('[data-index="0"]')) return box(104, 800, 172, 24);
    if (element.matches(".menu")) return box(100, 780, 180, 80);
    return undefined;
  });
  try {
    await page.render(menu(() => {}, { position: { left: 100, top: 780 } }));
    await openSubmenu(page);
    const sub = page.document.querySelector<HTMLElement>("[data-submenu]")!;
    assert.equal(parseFloat(sub.style.top), 900 - 300 - 8);
  } finally {
    await page.clean();
  }
});

test("a numeric-width menu is kept inside the window's width", async () => {
  const page = await environment((element) =>
    element.matches(".menu") ? box(1380, 100, 176, 80) : undefined,
  );
  try {
    await page.render(menu(() => {}, { position: { left: 1380, top: 100 } }));
    const frame = page.document.querySelector<HTMLElement>(".menu")!;
    assert.equal(parseFloat(frame.style.left), 1440 - 176 - 8);
  } finally {
    await page.clean();
  }
});

test("maxVisibleItems limits the list to that many rows", async () => {
  const page = await environment();
  try {
    await page.render(menu(() => {}, { maxVisibleItems: 8.5 }));
    const frame = page.document.querySelector<HTMLElement>(".menu")!;
    assert.match(frame.style.maxHeight, /^min\(214px,/);
  } finally {
    await page.clean();
  }
});
