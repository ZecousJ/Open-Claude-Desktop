import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { dismissAllToasts } from "../../src/ui/toast-store";
import { activateRoutineReadAccount } from "../../src/collections/routines/routine-read-receipts";
const capabilities = { remote: false, email: false, slack: false };
export async function routineDom(
  bridge: Partial<Window["desktop"]> = {},
  options: { jsdom?: boolean } = {},
) {
  const releaseAccount = activateRoutineReadAccount("synthetic-round4-account");
  const html = "<html><body><main></main></body></html>";
  const native = options.jsdom
    ? new (await import("jsdom")).JSDOM(html, {
        url: "http://localhost/",
        pretendToBeVisual: true,
      })
    : undefined;
  const { window, document } = native
    ? {
        window: native.window as unknown as ReturnType<
          typeof parseHTML
        >["window"],
        document: native.window.document,
      }
    : parseHTML(html);
  if (native) {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.assign(native.window.Range.prototype, {
      getClientRects: () => [],
      getBoundingClientRect: () => ({
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
      }),
    });
  }
  document.documentElement.dataset.motion = "reduced";
  (document as unknown as { oninput: null }).oninput = null;
  window.desktop = {
    routineCapabilities: async () => capabilities,
    routineRuns: async () => [],
    onEvent: () => () => {},
    ...bridge,
  } as never;
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    ...(native
      ? {
          navigator: native.window.navigator,
          MutationObserver: native.window.MutationObserver,
          Node: native.window.Node,
          Text: native.window.Text,
          Element: native.window.Element,
          HTMLElement: native.window.HTMLElement,
          getComputedStyle: native.window.getComputedStyle.bind(native.window),
        }
      : {}),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    // This harness runs the frame immediately, so there is no pending work.
    cancelAnimationFrame: (_handle: number) => {},
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
  window.matchMedia = (() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  const prototype = window.HTMLInputElement.prototype;
  const inputType = Object.getOwnPropertyDescriptor(prototype, "type");
  Object.defineProperty(prototype, "type", {
    configurable: true,
    get(this: HTMLInputElement) {
      return this.getAttribute("type") || "text";
    },
    set(this: HTMLInputElement, value: string) {
      this.setAttribute("type", value);
    },
  });
  const focus = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "focus",
  );
  let focused: HTMLElement | undefined;
  if (!native) {
    window.HTMLElement.prototype.focus = function () {
      focused = this;
    };
    Object.defineProperty(document, "activeElement", {
      get: () => (focused?.isConnected ? focused : document.body),
    });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const render = async (child: ReturnType<typeof createElement>) =>
    act(async () => {
      root.render(child);
    });
  const event = async (
    target: Element | Document,
    type: string,
    extra: Record<string, unknown> = {},
  ) => {
    const next = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(next, extra);
    await act(async () => {
      target.dispatchEvent(next);
    });
    return next;
  };
  const change = async (selector: string, value: string) => {
    const input = document.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >(selector)!;
    const proto =
      input.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const click = async (selector: string) =>
    event(document.querySelector(selector)!, "click", { button: 0 });
  const clean = async () => {
    await act(async () => {
      root.unmount();
      releaseAccount();
      dismissAllToasts();
    });
    if (inputType) Object.defineProperty(prototype, "type", inputType);
    else Reflect.deleteProperty(prototype, "type");
    if (focus)
      Object.defineProperty(window.HTMLElement.prototype, "focus", focus);
    else Reflect.deleteProperty(window.HTMLElement.prototype, "focus");
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    native?.window.close();
  };
  return { window, document, render, event, change, click, clean };
}
