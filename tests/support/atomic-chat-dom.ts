import { JSDOM } from "jsdom";
import { act, createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";

/** DOM semantics only: jsdom supplies real Selection/Range/MutationObserver,
 * not browser line layout or a physical platform input method. */
export async function atomicChatDom(bridge: Partial<Window["desktop"]> = {}) {
  const instance = new JSDOM(
    "<!doctype html><html><body><main></main></body></html>",
    { url: "http://localhost/", pretendToBeVisual: true },
  );
  const window = instance.window,
    document = window.document;
  // jsdom advertises Apple's vendor without implementing Safari's native
  // composition behavior. Exercise generic DOM editing here; root separately
  // checks the real platform/browser IME, including its end-key handling.
  Object.defineProperty(window.navigator, "vendor", {
    configurable: true,
    value: "",
  });
  const stylesheet = document.createElement("style");
  stylesheet.textContent = ".ProseMirror { white-space: pre-wrap }";
  document.head.append(stylesheet);
  (window as unknown as Window).desktop = {
    customizeSkills: async () => [
      {
        name: "review",
        path: "/fixture/review/SKILL.md",
        description: "Actual fixture review",
        enabled: true,
        own: true,
        scope: "user",
      },
    ],
    onEvent: () => () => {},
    ...bridge,
  } as never;
  const globals = {
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    DOMParser: window.DOMParser,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLInputElement: window.HTMLInputElement,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    innerWidth: 1440,
    innerHeight: 900,
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
  // No geometric claims are made by these semantic editor tests.
  Object.assign(window.Range.prototype, {
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
  window.scrollBy = () => {};
  const { createRoot } = await import("react-dom/client");
  const root: Root = createRoot(document.querySelector("main")!);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  return {
    window,
    document,
    settle,
    render: (child: ReactNode) => act(async () => root.render(child)),
    async key(target: Element, key: string, init: KeyboardEventInit = {}) {
      const event = new window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      await act(async () => {
        target.dispatchEvent(event);
      });
      return event;
    },
    async clean() {
      await act(async () => root.unmount());
      window.close();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
