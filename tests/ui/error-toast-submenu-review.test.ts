import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { useErrorToastClearance } from "../../src/ui/useErrorToastClearance";

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

async function page(initiallyExpanded: boolean) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.innerWidth = 1440;
  window.innerHeight = 900;
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  class Resize {
    observe() {}
    unobserve() {}
    disconnect() {}
    constructor(_callback: ResizeObserverCallback) {}
  }
  class Mutation {
    static current: Mutation;
    constructor(readonly callback: MutationCallback) {
      Mutation.current = this;
    }
    observe() {}
    disconnect() {}
    emit(node: Node) {
      this.callback(
        [
          {
            type: "childList",
            addedNodes: [node],
            removedNodes: [],
          } as unknown as MutationRecord,
        ],
        this as unknown as MutationObserver,
      );
    }
  }
  const oldRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches(".composer-wrap")) return box(500, 752, 768, 132);
    if (this.matches(".code-model-menu")) return box(1100, 670, 180, 114);
    // A valid one-model catalog with all six effort levels opens a 191px
    // absolute panel to the left; it extends above the root menu's bounds.
    if (this.matches(".code-session-effort, .code-session-effort-wrap"))
      return box(774, 564, 320, 191);
    if (this.matches(".error-banner"))
      return box(
        1066,
        900 - (parseFloat(this.style.bottom) || 16) - 44,
        358,
        44,
      );
    return box(0, 0, 1440, 900);
  };
  const stylePrototype = Object.getPrototypeOf(
    document.createElement("div").style,
  );
  const priority = Object.getOwnPropertyDescriptor(
    stylePrototype,
    "getPropertyPriority",
  );
  if (!priority)
    Object.defineProperty(stylePrototype, "getPropertyPriority", {
      configurable: true,
      value: () => "",
    });
  const globals = {
    window,
    document,
    ResizeObserver: Resize,
    MutationObserver: Mutation,
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
  window.getComputedStyle = (() => ({
    display: "block",
    visibility: "visible",
  })) as unknown as typeof getComputedStyle;
  window.requestAnimationFrame = (callback) => {
    frames.set(++next, callback);
    return next;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  function Toast() {
    const ref = useErrorToastClearance(true, "Synthetic review error");
    return createElement(
      "div",
      { ref, className: "error-banner" },
      createElement("button", null, "Close"),
    );
  }
  function View({ expanded }: { expanded: boolean }) {
    return createElement(
      "div",
      { className: "app web" },
      createElement("div", { className: "composer-wrap" }),
      createElement(
        "div",
        { className: "code-model-menu" },
        expanded &&
          createElement(
            "div",
            { className: "code-model-more code-session-effort-wrap" },
            createElement("div", {
              className: "code-model-submenu code-session-effort",
              role: "menu",
            }),
          ),
      ),
      createElement(Toast),
    );
  }
  await act(async () =>
    root.render(createElement(View, { expanded: initiallyExpanded })),
  );
  return {
    document,
    frames,
    async expand() {
      await act(async () =>
        root.render(createElement(View, { expanded: true })),
      );
    },
    mutation() {
      Mutation.current.emit(
        document.querySelector(".code-session-effort-wrap")!,
      );
    },
    async flush() {
      await act(async () => {
        for (const [id, callback] of [...frames]) {
          frames.delete(id);
          callback(0);
        }
      });
    },
    async restore() {
      await act(async () => root.unmount());
      window.HTMLElement.prototype.getBoundingClientRect = oldRect;
      if (priority)
        Object.defineProperty(stylePrototype, "getPropertyPriority", priority);
      else Reflect.deleteProperty(stylePrototype, "getPropertyPriority");
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("error clearance includes an absolute Effort panel outside its root menu bounds", async () => {
  const env = await page(true);
  try {
    const toast = env.document.querySelector<HTMLElement>(".error-banner")!;
    const panel = env.document.querySelector<HTMLElement>(
      ".code-session-effort",
    )!;
    const t = toast.getBoundingClientRect(),
      p = panel.getBoundingClientRect();
    assert.ok(
      t.left < p.right && t.right > p.left,
      "panel intersects the actual toast column",
    );
    assert.ok(
      t.bottom <= p.top - 16,
      `toast bottom ${t.bottom} must clear panel top ${p.top} by 16px`,
    );
  } finally {
    await env.restore();
  }
});

test("opening an absolute Effort panel schedules clearance even when the root never resizes", async () => {
  const env = await page(false);
  try {
    await env.expand();
    env.mutation();
    assert.equal(
      env.frames.size,
      1,
      "the added submenu subtree must invalidate the region list",
    );
    await env.flush();
    const toast = env.document.querySelector<HTMLElement>(".error-banner")!;
    const panel = env.document.querySelector<HTMLElement>(
      ".code-session-effort",
    )!;
    assert.ok(
      toast.getBoundingClientRect().bottom <=
        panel.getBoundingClientRect().top - 16,
    );
  } finally {
    await env.restore();
  }
});
