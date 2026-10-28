import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { parseHTML } from "linkedom";
import type { AppController } from "../../src/app/AppContext";
import { desktopHost, webHost } from "../../shared/host";
import { errorToastBottom } from "../../src/ui/useErrorToastClearance";

const rect = (left: number, top: number, width: number, height: number) => ({
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

test("safe-region geometry uses horizontal overlap and the official 200px composer threshold", () => {
  const toast = rect(1066, 840, 358, 44);
  assert.equal(errorToastBottom(900, toast, []), 16);
  assert.equal(
    errorToastBottom(900, toast, [
      { rect: rect(500, 752, 768, 132), nearBottomOnly: true },
    ]),
    164,
  );
  assert.equal(
    errorToastBottom(900, toast, [
      { rect: rect(500, 400, 768, 132), nearBottomOnly: true },
    ]),
    16,
  );
  assert.equal(
    errorToastBottom(900, toast, [
      { rect: rect(10, 752, 200, 132), nearBottomOnly: true },
    ]),
    16,
  );
  assert.equal(
    errorToastBottom(900, toast, [
      { rect: rect(1016, 412, 320, 432), nearBottomOnly: false },
    ]),
    504,
  );
  assert.equal(
    errorToastBottom(120, rect(16, 60, 358, 104), [
      { rect: rect(0, 0, 390, 120), nearBottomOnly: false },
    ]),
    8,
  );
});

async function environment() {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let composerRect = rect(500, 752, 768, 132);
  let menuRect = rect(1016, 412, 320, 432);
  let toastHeight = 44;
  window.innerWidth = 1440;
  window.innerHeight = 900;
  class Resize {
    static all: Resize[] = [];
    observed = new Set<Element>();
    disconnected = false;
    constructor(readonly callback: ResizeObserverCallback) {
      Resize.all.push(this);
    }
    observe(element: Element) {
      this.observed.add(element);
    }
    unobserve(element: Element) {
      this.observed.delete(element);
    }
    disconnect() {
      this.observed.clear();
      this.disconnected = true;
    }
    emit() {
      this.callback([], this as unknown as ResizeObserver);
    }
  }
  class Mutation {
    static all: Mutation[] = [];
    options?: MutationObserverInit;
    disconnected = false;
    constructor(readonly callback: MutationCallback) {
      Mutation.all.push(this);
    }
    observe(_element: Node, options: MutationObserverInit) {
      this.options = options;
    }
    disconnect() {
      this.disconnected = true;
    }
    takeRecords() {
      return [];
    }
    emit(records: Partial<MutationRecord>[]) {
      this.callback(
        records as MutationRecord[],
        this as unknown as MutationObserver,
      );
    }
  }
  const oldRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("composer-wrap")) return composerRect;
    if (this.matches(".code-model-menu,.model-menu")) return menuRect;
    if (this.matches(".code-model-submenu,.model-submenu"))
      return rect(774, 564, 320, 191);
    if (this.classList.contains("error-banner")) {
      const width = Math.min(358, window.innerWidth - 32);
      const limit = parseFloat(this.style.maxHeight);
      const height = Number.isFinite(limit)
        ? Math.min(limit, toastHeight)
        : toastHeight;
      return rect(
        window.innerWidth - width - 16,
        window.innerHeight - (parseFloat(this.style.bottom) || 16) - height,
        width,
        height,
      );
    }
    return rect(0, 0, window.innerWidth, window.innerHeight);
  };
  const stylePrototype = Object.getPrototypeOf(
    document.createElement("div").style,
  );
  const oldPriority = Object.getOwnPropertyDescriptor(
    stylePrototype,
    "getPropertyPriority",
  );
  if (!oldPriority)
    Object.defineProperty(stylePrototype, "getPropertyPriority", {
      configurable: true,
      value: () => "",
    });
  const globals = {
    window,
    document,
    ResizeObserver: Resize,
    MutationObserver: Mutation,
    getComputedStyle: (element: HTMLElement) => ({
      display: element.style.display || "block",
      visibility: element.style.visibility || "visible",
    }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
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
  window.getComputedStyle =
    globals.getComputedStyle as unknown as typeof getComputedStyle;
  window.requestAnimationFrame = globals.requestAnimationFrame;
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  const { createRoot } = await import("react-dom/client");
  const { AppContext } = await import("../../src/app/AppContext");
  const { HostContext } = await import("../../src/host/HostContext");
  const { ErrorBanner } = await import("../../src/app/AppOverlays");
  const { GlobalLimitView } = await import("../../src/policy/GlobalLimitToast");
  const root = createRoot(document.querySelector("main")!);
  let changeMessage: (message: string) => void = () => {};
  function Harness({
    native = false,
    menu = false,
    chatMenu = false,
    quota = false,
    mobile = false,
  }: {
    native?: boolean;
    menu?: boolean;
    chatMenu?: boolean;
    quota?: boolean;
    mobile?: boolean;
  }) {
    const [error, setError] = useState("Couldn’t load cloud environments");
    changeMessage = setError;
    return createElement(
      HostContext.Provider,
      { value: native ? desktopHost : webHost },
      createElement(
        AppContext.Provider,
        { value: { error, setError } as unknown as AppController },
        createElement(
          "div",
          {
            className: native
              ? "app"
              : mobile
                ? "app web mobile-conversation"
                : "app web",
          },
          createElement(
            "div",
            { className: "composer-wrap" },
            createElement("button", { id: "model" }, "Model"),
          ),
          menu &&
            createElement(
              "div",
              {
                className: chatMenu ? "model-menu" : "code-model-menu",
                id: "menu",
              },
              "Menu",
            ),
          createElement(ErrorBanner),
          quota &&
            createElement(GlobalLimitView, {
              notice: { kind: "rate-limit", resetsAt: Date.now() + 60000 },
              onDismiss() {},
            }),
        ),
      ),
    );
  }
  const flush = () =>
    act(async () => {
      const current = [...frames];
      frames.clear();
      for (const [, callback] of current) callback(0);
    });
  return {
    window,
    document,
    Resize,
    Mutation,
    frames,
    flush,
    composer: (value: ReturnType<typeof rect>) => {
      composerRect = value;
    },
    menu: (value: ReturnType<typeof rect>) => {
      menuRect = value;
    },
    height: (value: number) => {
      toastHeight = value;
    },
    async render(props: Parameters<typeof Harness>[0] = {}) {
      await act(async () => root.render(createElement(Harness, props)));
    },
    async message(value: string) {
      await act(async () => changeMessage(value));
    },
    async click(target: Element) {
      await act(async () =>
        target.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
    },
    async restore() {
      await act(async () => root.unmount());
      window.HTMLElement.prototype.getBoundingClientRect = oldRect;
      if (oldPriority)
        Object.defineProperty(
          stylePrototype,
          "getPropertyPriority",
          oldPriority,
        );
      else Reflect.deleteProperty(stylePrototype, "getPropertyPriority");
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("actual web ErrorBanner clears the Code chin in its initial layout effect", async () => {
  const env = await environment();
  try {
    await env.render();
    const toast = env.document.querySelector<HTMLElement>(".error-banner")!;
    assert.equal(
      toast.style.bottom,
      "164px",
      "positioned before any observer/frame flush",
    );
    assert.equal(toast.getBoundingClientRect().bottom, 736);
    assert.ok(
      toast.getBoundingClientRect().bottom < 752,
      "toast is above the actionable composer",
    );
    assert.ok(toast.querySelector('button[aria-label="Dismiss error"]'));
    assert.equal(
      env.Mutation.all[0].options?.attributeFilter?.includes("style"),
      false,
    );
  } finally {
    await env.restore();
  }
});

test("opened Code/Chat model menus join clearance and release it when unmounted", async () => {
  for (const chatMenu of [false, true]) {
    const env = await environment();
    try {
      await env.render();
      await env.render({ menu: true, chatMenu });
      const menu = env.document.querySelector<HTMLElement>("#menu")!;
      const toast = env.document.querySelector<HTMLElement>(".error-banner")!;
      env.Mutation.all[0].emit([
        {
          type: "childList",
          addedNodes: [menu] as unknown as NodeList,
          removedNodes: [] as unknown as NodeList,
        },
      ]);
      await env.flush();
      assert.equal(toast.style.bottom, "504px");
      assert.ok(
        toast.getBoundingClientRect().bottom < menu.getBoundingClientRect().top,
      );
      assert.ok(env.Resize.all[0].observed.has(menu));
      await env.render();
      env.Mutation.all[0].emit([
        {
          type: "childList",
          addedNodes: [] as unknown as NodeList,
          removedNodes: [menu] as unknown as NodeList,
        },
      ]);
      await env.flush();
      assert.equal(toast.style.bottom, "164px");
      assert.equal(env.Resize.all[0].observed.has(menu), false);
    } finally {
      await env.restore();
    }
  }
});

test("Code and Chat absolute model/effort submenus join and release their own safe region", async () => {
  for (const className of [
    "code-model-submenu code-session-effort",
    "code-model-submenu",
    "model-submenu effort-submenu",
    "model-submenu models-submenu",
  ]) {
    const env = await environment();
    try {
      env.menu(rect(1100, 670, 180, 114));
      await env.render({
        menu: true,
        chatMenu: className.startsWith("model-"),
      });
      const toast = env.document.querySelector<HTMLElement>(".error-banner")!;
      assert.equal(toast.style.bottom, "246px");
      const wrapper = env.document.createElement("div");
      const panel = env.document.createElement("div");
      panel.className = className;
      wrapper.append(panel);
      env.document.querySelector("#menu")!.append(wrapper);
      env.Mutation.all[0].emit([
        {
          type: "childList",
          addedNodes: [wrapper] as unknown as NodeList,
          removedNodes: [] as unknown as NodeList,
        },
      ]);
      assert.equal(env.frames.size, 1, className);
      await env.flush();
      assert.equal(toast.style.bottom, "352px", className);
      assert.equal(toast.getBoundingClientRect().bottom, 548);
      assert.ok(env.Resize.all[0].observed.has(panel));
      wrapper.remove();
      env.Mutation.all[0].emit([
        {
          type: "childList",
          addedNodes: [] as unknown as NodeList,
          removedNodes: [wrapper] as unknown as NodeList,
        },
      ]);
      await env.flush();
      assert.equal(toast.style.bottom, "246px");
      assert.equal(env.Resize.all[0].observed.has(panel), false);
    } finally {
      await env.restore();
    }
  }
});

test("resize and window changes track geometry; unrelated mutations and own style writes cannot storm", async () => {
  const env = await environment();
  try {
    await env.render();
    const toast = env.document.querySelector<HTMLElement>(".error-banner")!;
    for (let index = 0; index < 100; index++) {
      env.Mutation.all[0].emit([
        { type: "attributes", attributeName: "style", target: toast },
      ]);
      env.Mutation.all[0].emit([
        {
          type: "childList",
          addedNodes: [
            env.document.createTextNode("token"),
          ] as unknown as NodeList,
          removedNodes: [] as unknown as NodeList,
        },
      ]);
    }
    assert.equal(env.frames.size, 0);
    env.composer(rect(500, 700, 768, 184));
    for (let index = 0; index < 100; index++) env.Resize.all[0].emit();
    assert.equal(env.frames.size, 1);
    await env.flush();
    assert.equal(toast.style.bottom, "216px");
    assert.equal(env.frames.size, 0);
    env.window.innerWidth = 390;
    env.window.innerHeight = 844;
    env.composer(rect(8, 650, 374, 178));
    env.window.dispatchEvent(new env.window.Event("resize"));
    await env.flush();
    assert.equal(toast.style.bottom, "210px");
    assert.equal(toast.getBoundingClientRect().bottom, 634);
  } finally {
    await env.restore();
  }
});

test("hidden/off-column/upper composers do not reserve space; a short viewport keeps the error Close visible", async () => {
  const env = await environment();
  try {
    env.composer(rect(10, 752, 200, 132));
    await env.render();
    const toast = env.document.querySelector<HTMLElement>(".error-banner")!;
    assert.equal(toast.style.bottom, "16px");
    env.composer(rect(500, 400, 768, 132));
    env.Resize.all[0].emit();
    await env.flush();
    assert.equal(toast.style.bottom, "16px");
    env.composer(rect(500, 752, 768, 132));
    const composer = env.document.querySelector<HTMLElement>(".composer-wrap")!;
    composer.hidden = true;
    env.Mutation.all[0].emit([
      { type: "attributes", attributeName: "hidden", target: composer },
    ]);
    await env.flush();
    assert.equal(toast.style.bottom, "16px");
    composer.hidden = false;
    env.window.innerWidth = 390;
    env.window.innerHeight = 120;
    env.composer(rect(8, 0, 374, 120));
    env.height(200);
    env.window.dispatchEvent(new env.window.Event("resize"));
    await env.flush();
    assert.equal(toast.style.maxHeight, "104px");
    assert.equal(toast.style.overflowY, "auto");
    assert.equal(toast.style.bottom, "8px");
    assert.equal(toast.getBoundingClientRect().top, 8);
    await env.click(toast.querySelector('button[aria-label="Dismiss error"]')!);
    assert.equal(Boolean(env.document.querySelector(".error-banner")), false);
  } finally {
    await env.restore();
  }
});

test("native and real quota notices keep their corner styles; observers and queued work clean up", async () => {
  const env = await environment();
  try {
    await env.render({ quota: true });
    const quota = env.document.querySelector<HTMLElement>(
      '[data-limit="rate-limit"]',
    )!;
    assert.equal(quota.style.bottom, undefined);
    assert.equal(quota.style.maxHeight, undefined);
    const toast = env.document.querySelector<HTMLElement>(".error-banner")!;
    env.Resize.all[0].emit();
    assert.equal(env.frames.size, 1);
    await env.message("");
    assert.equal(env.frames.size, 0);
    assert.ok(env.Resize.all[0].disconnected);
    assert.ok(env.Mutation.all[0].disconnected);
    assert.equal(toast.style.getPropertyValue("bottom"), undefined);
    env.window.dispatchEvent(new env.window.Event("resize"));
    assert.equal(env.frames.size, 0);
    await env.message("Native error");
    await env.render({ native: true });
    const native = env.document.querySelector<HTMLElement>(".error-banner")!;
    assert.equal(native.style.getPropertyValue("bottom"), undefined);
    assert.equal(native.style.getPropertyValue("max-height"), undefined);
    await env.render({ mobile: true });
    const mobile = env.document.querySelector<HTMLElement>(".error-banner")!;
    assert.equal(mobile.style.getPropertyValue("bottom"), undefined);
    assert.equal(mobile.style.getPropertyValue("max-height"), undefined);
  } finally {
    await env.restore();
  }
});
