import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, createRef } from "react";
import { parseHTML } from "linkedom";

test("Code's composer box measures its height again when its width changes", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const watchers: (() => void)[] = [];
  class FakeResizeObserver {
    constructor(callback: () => void) {
      watchers.push(callback);
    }
    observe() {}
    disconnect() {}
  }
  const globals: Record<string, unknown> = {
    window,
    document,
    ResizeObserver: FakeResizeObserver,
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
  const { useComposerAutosize } = await import("../../src/app/ComposerHost");
  const { createRoot } = await import("react-dom/client");
  // A text area whose content needs `lines` lines of 20px at its width.
  const field = document.createElement("textarea") as unknown as HTMLElement & {
    scrollHeight: number;
    clientWidth: number;
  };
  let lines = 1;
  Object.defineProperty(field, "scrollHeight", { get: () => lines * 20 });
  Object.defineProperty(field, "clientWidth", { value: 600, writable: true });
  document.querySelector("main")!.append(field);
  const ref = createRef<never>();
  (ref as { current: unknown }).current = field;
  function Harness() {
    useComposerAutosize(ref as never, "text", "code", "c1");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Harness)));
    assert.equal(field.style.height, "20px");
    // Narrowed: the same text wraps onto three lines.
    lines = 3;
    watchers.forEach((watch) => watch());
    assert.equal(field.style.height, "20px", "the same width changes nothing");
    (field as { clientWidth: number }).clientWidth = 300;
    watchers.forEach((watch) => watch());
    assert.equal(field.style.height, "60px");
    // Never past Code's 380px.
    lines = 40;
    (field as { clientWidth: number }).clientWidth = 200;
    watchers.forEach((watch) => watch());
    assert.equal(field.style.height, "380px");
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
