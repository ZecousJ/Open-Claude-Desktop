import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, StrictMode, useLayoutEffect, useRef } from "react";
import { parseHTML } from "linkedom";
import { useComposerMorph } from "../../src/composer/useComposerMorph";

async function environment(initialTransition = "", initialPriority = "") {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const metrics = { row: 400, lead: 0, trail: 32 };
  const commits: {
    transition: string;
    priority: string;
    lead: string;
    trail: string;
  }[] = [];
  const observers = new Set<Observer>();
  class Observer {
    targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.add(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
  }
  const create = document.createElement.bind(document);
  document.createElement = ((
    name: string,
    options?: ElementCreationOptions,
  ) => {
    const element = create(name, options);
    if (name === "canvas")
      Object.assign(element, {
        getContext: () => ({
          measureText: (text: string) => ({ width: text.length * 8 }),
        }),
      });
    return element;
  }) as Document["createElement"];
  const globals = {
    window,
    document,
    ResizeObserver: Observer,
    getComputedStyle: () => ({
      fontStyle: "normal",
      fontWeight: "400",
      fontSize: "15px",
      fontFamily: "sans-serif",
      maxHeight: "300px",
    }),
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
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const configured = new WeakSet<Element>();
  function Probe({ enabled }: { enabled: boolean }) {
    const row = useRef<HTMLDivElement>(null),
      lead = useRef<HTMLDivElement>(null),
      trail = useRef<HTMLDivElement>(null),
      field = useRef<HTMLTextAreaElement>(null);
    // Supply explicit layout metrics/CSSOM support before the real hook reads.
    useLayoutEffect(() => {
      const box = row.current!;
      if (configured.has(box)) return;
      configured.add(box);
      const nativeStyle = box.style;
      const set = nativeStyle.setProperty.bind(nativeStyle),
        remove = nativeStyle.removeProperty.bind(nativeStyle);
      const priorities = new Map<string, string>();
      // Linkedom omits CSS priority. Keep its real declarations and supply
      // that missing CSSOM contract through this element's facade.
      const style = new Proxy(nativeStyle, {
        get(target, name) {
          if (name === "setProperty")
            return (key: string, value: string, priority = "") => {
              priorities.set(key, priority);
              set(key, value);
            };
          if (name === "removeProperty")
            return (key: string) => {
              priorities.delete(key);
              return remove(key);
            };
          if (name === "getPropertyPriority")
            return (key: string) => priorities.get(key) ?? "";
          const value = Reflect.get(target, name);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      Object.defineProperty(box, "style", {
        configurable: true,
        get: () => style,
      });
      if (initialTransition)
        style.setProperty("transition", initialTransition, initialPriority);
      Object.defineProperty(box, "clientWidth", {
        configurable: true,
        get() {
          commits.push({
            transition: style.getPropertyValue("transition"),
            priority: style.getPropertyPriority("transition"),
            lead: style.getPropertyValue("--composer-lead-w"),
            trail: style.getPropertyValue("--composer-trail-w"),
          });
          return metrics.row;
        },
      });
      Object.defineProperty(lead.current!, "offsetWidth", {
        configurable: true,
        get: () => metrics.lead,
      });
      Object.defineProperty(trail.current!, "offsetWidth", {
        configurable: true,
        get: () => metrics.trail,
      });
      Object.defineProperty(field.current!, "clientWidth", {
        configurable: true,
        get: () => metrics.row - metrics.lead - metrics.trail,
      });
    }, []);
    const twoRows = useComposerMorph(enabled, row, lead, trail, field, "");
    return createElement(
      "div",
      { ref: row, id: "row", "data-two-rows": twoRows },
      createElement("div", { ref: lead, id: "lead" }),
      createElement("textarea", { ref: field }),
      createElement("div", { ref: trail, id: "trail" }),
    );
  }
  return {
    document,
    metrics,
    commits,
    observers,
    async render(enabled = true, strict = false) {
      const node = createElement(Probe, { enabled });
      await act(async () =>
        root.render(strict ? createElement(StrictMode, null, node) : node),
      );
    },
    async resizeTrail() {
      const target = document.querySelector("#trail")!;
      await act(async () => {
        for (const observer of [...observers])
          if (observer.targets.has(target))
            observer.callback([], observer as unknown as ResizeObserver);
      });
    },
    async clean() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("real composer morph commits its first measured padding without a transition, then restores the original inline priority", async () => {
  const page = await environment(
    "padding 0.4s ease, opacity 1s linear",
    "important",
  );
  try {
    await page.render();
    assert.deepEqual(page.commits, [
      { transition: "none", priority: "important", lead: "0px", trail: "40px" },
    ]);
    const style = page.document.querySelector<HTMLElement>("#row")!.style;
    assert.equal(
      style.getPropertyValue("transition"),
      "padding 0.4s ease, opacity 1s linear",
    );
    assert.equal(style.getPropertyPriority("transition"), "important");
    page.metrics.lead = 24;
    page.metrics.trail = 72;
    await page.resizeTrail();
    assert.deepEqual(page.commits.at(-1), {
      transition: "padding 0.4s ease, opacity 1s linear",
      priority: "important",
      lead: "32px",
      trail: "80px",
    });
  } finally {
    await page.clean();
  }
});

test("morph leaves stylesheet transitions intact, does nothing while disabled, and disconnects when disabled again", async () => {
  const page = await environment();
  try {
    await page.render(false);
    assert.equal(page.commits.length, 0);
    assert.equal(page.observers.size, 0);
    await page.render(true);
    assert.equal(page.commits[0].transition, "none");
    const style = page.document.querySelector<HTMLElement>("#row")!.style;
    assert.equal(style.getPropertyValue("transition"), undefined);
    assert.equal(style.getPropertyPriority("transition"), "");
    page.metrics.trail = 16;
    await page.resizeTrail();
    assert.equal(
      style.getPropertyValue("--composer-trail-w"),
      "24px",
      "the hook measures the real control width rather than fixing it at 40",
    );
    assert.equal(page.commits.at(-1)!.transition, undefined);
    await page.render(false);
    const count = page.commits.length;
    page.metrics.trail = 100;
    await page.resizeTrail();
    assert.equal(page.commits.length, count);
    assert.equal(page.observers.size, 0);
  } finally {
    await page.clean();
  }
});

test("morph StrictMode replay suppresses both initial measurements without leaking the suppression or duplicate observers", async () => {
  const page = await environment("padding 200ms ease");
  try {
    await page.render(true, true);
    assert.equal(page.commits.length, 2);
    assert.ok(page.commits.every((entry) => entry.transition === "none"));
    assert.equal(
      page.observers.size,
      2,
      "one action observer and one textarea observer remain",
    );
    const style = page.document.querySelector<HTMLElement>("#row")!.style;
    assert.equal(style.getPropertyValue("transition"), "padding 200ms ease");
    page.metrics.trail = 64;
    await page.resizeTrail();
    assert.equal(page.commits.at(-1)!.transition, "padding 200ms ease");
    assert.equal(style.getPropertyValue("--composer-trail-w"), "72px");
  } finally {
    await page.clean();
  }
});
