import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";

test("a sidebar the user closed starts closed on the next start, and opened starts open", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  const globals: Record<string, unknown> = {
    window,
    document,
    localStorage,
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
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
  const { useSidebarVisibility } =
    await import("../../src/sidebar/useSidebarVisibility");
  const { createRoot } = await import("react-dom/client");
  let current: ReturnType<typeof useSidebarVisibility>;
  function Harness() {
    current = useSidebarVisibility();
    return null;
  }
  const mount = async () => {
    const root = createRoot(document.querySelector("main")!);
    await act(async () => root.render(createElement(Harness)));
    return root;
  };
  try {
    let root = await mount();
    assert.equal(current!.open, true);
    await act(async () => current!.toggle());
    assert.equal(current!.open, false);
    assert.equal(JSON.parse(store.get("claudex.boot")!).sidebarCollapsed, true);
    await act(async () => root.unmount());

    root = await mount();
    assert.equal(current!.open, false, "it starts as it was left");
    await act(async () => current!.toggle());
    assert.equal(current!.open, true);
    assert.equal(
      JSON.parse(store.get("claudex.boot")!).sidebarCollapsed,
      false,
    );
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
