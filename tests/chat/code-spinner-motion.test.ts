import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the Code spinner holds still when the app's Motion setting is Reduced", async () => {
  const { window } = parseHTML(
    "<!doctype html><html><body><main></main></body></html>",
  );
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
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
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { CodeSpinner } = await import("../../src/transcript/CodeTurnStatus");
  const main = window.document.querySelector("main")!;
  const root = createRoot(main);
  try {
    window.document.documentElement.dataset.motion = "reduced";
    await React.act(async () => root.render(React.createElement(CodeSpinner)));
    const step = () => main.querySelector("svg")!.getAttribute("data-step");
    const first = step();
    await React.act(async () => {
      await wait(320);
    });
    assert.equal(step(), first);
    root.unmount();

    // Without it the spinner steps on.
    delete window.document.documentElement.dataset.motion;
    const moving = createRoot(main);
    await React.act(async () =>
      moving.render(React.createElement(CodeSpinner)),
    );
    const seen = new Set<string | null>();
    for (let i = 0; i < 6; i++) {
      await React.act(async () => {
        await wait(100);
      });
      seen.add(step());
    }
    assert.ok(seen.size > 1);
    moving.unmount();
  } finally {
    await wait(30);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
