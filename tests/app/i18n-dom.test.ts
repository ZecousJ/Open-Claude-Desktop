import test from "node:test";
import { parseHTML } from "linkedom";

test("mounted sharing UI, DOM accessibility and user content survive runtime language changes", async () => {
  const { window } = parseHTML("<!doctype html><html><body></body></html>");
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    MutationObserver: window.MutationObserver,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  try {
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value,
      });
    const { run } = await import("../fixtures/i18n-dom");
    await run();
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
