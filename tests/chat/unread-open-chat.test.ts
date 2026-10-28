import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

test("the chat on screen reads an unread mark set elsewhere, but keeps one set here by hand", async () => {
  const { window } = parseHTML(
    "<!doctype html><html><body><main></main></body></html>",
  );
  const calls: { id: string; patch: unknown }[] = [];
  const globals: Record<string, unknown> = {
    window: Object.assign(window, {
      desktop: {
        updateConversation: async (id: string, patch: unknown) => {
          calls.push({ id, patch });
          return { id, unread: false };
        },
        discardIncognito: async () => {},
      },
    }),
    document: window.document,
    navigator: { userAgent: "node" },
  };
  const saved = new Map(
    Object.keys(globals).map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  for (const [k, v] of Object.entries(globals))
    Object.defineProperty(globalThis, k, {
      configurable: true,
      writable: true,
      value: v,
    });
  try {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { useChatLifecycle } =
      await import("../../src/conversation/useChatLifecycle");
    const { markedUnreadByHand } =
      await import("../../src/conversation/unread");
    const chat = (id: string, unread: boolean) =>
      ({ id, unread, turns: [] }) as any;
    let active = chat("a", false);
    const View = () => {
      useChatLifecycle({
        active,
        page: "chat",
        incognito: false,
        endIncognito() {},
        setSnapshot() {},
        upsert() {},
        report() {},
      });
      return null;
    };
    const root = createRoot(window.document.querySelector("main")!);
    const render = () =>
      flushSync(() => root.render(React.createElement(View)));
    render();
    assert.equal(calls.length, 0);
    // Another window marked the open chat unread: read at once.
    active = chat("a", true);
    render();
    assert.deepEqual(calls.at(-1), { id: "a", patch: { unread: false } });
    // Marked unread here by hand: kept while it stays open.
    calls.length = 0;
    markedUnreadByHand.add("a");
    active = chat("a", false);
    render();
    active = chat("a", true);
    render();
    assert.equal(calls.length, 0);
    // Opening another unread chat reads it.
    active = chat("b", true);
    render();
    assert.deepEqual(calls.at(-1), { id: "b", patch: { unread: false } });
    root.unmount();
    // React finishes its scheduled work before the globals go away.
    // Under a loaded full run that work can take a while: wait for a few
    // quiet turns of the event loop, not a fixed moment.
    for (let i = 0; i < 10; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else Reflect.deleteProperty(globalThis, k);
    }
  }
});
