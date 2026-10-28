import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { usePaletteSearch } from "../../src/collections/search/use-palette-search";

test("deeper search debounces, ignores stale replies and falls back to titles on failure", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
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
  const calls: {
    query: string;
    resolve: (value: { results: [] }) => void;
    reject: (error: Error) => void;
  }[] = [];
  window.desktop = {
    searchConversations: (query) =>
      new Promise((resolve, reject) => calls.push({ query, resolve, reject })),
  } as typeof window.desktop;
  let current: ReturnType<typeof usePaletteSearch>;
  function Harness({
    query,
    enabled = true,
  }: {
    query: string;
    enabled?: boolean;
  }) {
    current = usePaletteSearch(query, enabled);
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const render = (query: string, enabled = true) =>
    act(() => root.render(createElement(Harness, { query, enabled })));
  const wait = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 330));
    });
  try {
    await render("first");
    assert.equal(current!.pending, true);
    await render("second");
    await wait();
    assert.deepEqual(
      calls.map((call) => call.query),
      ["second"],
    );
    await render("third");
    await act(async () => calls[0].resolve({ results: [] }));
    assert.equal(current!.pending, true);
    await wait();
    await act(async () => calls[1].reject(new Error("Unavailable")));
    assert.equal(current!.pending, false);
    assert.equal(current!.titlesOnly, true);
    await render("", false);
    assert.equal(current!.pending, false);
    assert.equal(current!.titlesOnly, false);
    await render("x".repeat(201));
    await wait();
    assert.equal(calls.length, 2);
    assert.equal(current!.pending, false);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
