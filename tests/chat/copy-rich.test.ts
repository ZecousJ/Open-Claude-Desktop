import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `body` with a linkedom window installed as the global DOM. */
async function withDom(body: (window: any) => Promise<void>) {
  const { window } = parseHTML(
    "<!doctype html><html><body><main></main></body></html>",
  );
  const globals: Record<string, unknown> = {
    window,
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
    await body(window);
  } finally {
    await wait(30);
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else Reflect.deleteProperty(globalThis, k);
    }
  }
}

test("a Chat prompt copies as trimmed text and rich text; a plain prompt copy stays text only", async () => {
  await withDom(async (window) => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { CopyButton } = await import("../../src/ui/Controls");
    const { ConversationServicesContext, desktopConversationServices } =
      await import("../../src/conversation/ConversationServices");
    const copies: { text: string; html?: string }[] = [];
    const services = {
      ...desktopConversationServices,
      copyText: async (text: string, html?: string) => {
        copies.push({ text, html });
      },
    };
    const host = window.document.querySelector("main");
    const root = createRoot(host);
    const render = (rich: boolean | undefined) =>
      flushSync(() =>
        root.render(
          React.createElement(
            ConversationServicesContext.Provider,
            { value: services },
            React.createElement(CopyButton, {
              text: "  **bold** line\nnext line  ",
              iconOnly: true,
              message: "prompt",
              rich,
            }),
          ),
        ),
      );
    render(true);
    host.querySelector("button").click();
    for (let i = 0; i < 50 && !copies.length; i++) await wait(10);
    assert.equal(copies[0].text, "**bold** line\nnext line");
    assert.match(copies[0].html ?? "", /<strong>bold<\/strong> line<br\/>/);
    render(undefined);
    await wait(10);
    host.querySelector("button").click();
    for (let i = 0; i < 50 && copies.length < 2; i++) await wait(10);
    assert.equal(copies[1].text, "**bold** line\nnext line");
    assert.equal(copies[1].html, undefined);
    flushSync(() => root.unmount());
  });
});
