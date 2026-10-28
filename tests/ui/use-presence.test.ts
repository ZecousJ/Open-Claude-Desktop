import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits for an exit timer, allowing for a loaded machine. */
const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await wait(20);
};

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
    // React finishes its scheduled work before the globals go away.
    await wait(30);
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else Reflect.deleteProperty(globalThis, k);
    }
  }
}

test("usePresence keeps a closed overlay for its exit, and reopens it in place", async () => {
  await withDom(async (window) => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { usePresence } = await import("../../src/ui/usePresence");
    const seen: { mounted: boolean; state: string }[] = [];
    let open = false;
    const View = () => {
      seen.push(usePresence(open, 40));
      return null;
    };
    const root = createRoot(window.document.querySelector("main"));
    const render = () =>
      flushSync(() => root.render(React.createElement(View)));
    const last = () => seen.at(-1)!;

    render();
    assert.deepEqual(last(), { mounted: false, state: "closed" });
    open = true;
    render();
    assert.deepEqual(last(), { mounted: true, state: "open" });

    // Closing: still mounted, marked closed, gone after the exit.
    open = false;
    render();
    assert.deepEqual(last(), { mounted: true, state: "closed" });
    await until(() => !last().mounted);
    assert.deepEqual(last(), { mounted: false, state: "closed" });

    // Reopened during the exit: open again, and the exit timer is dropped.
    open = true;
    render();
    open = false;
    render();
    await wait(10);
    open = true;
    render();
    await wait(70);
    assert.deepEqual(last(), { mounted: true, state: "open" });

    // Reduced motion: no exit to wait for.
    window.document.documentElement.dataset.motion = "reduced";
    open = false;
    render();
    assert.deepEqual(last(), { mounted: false, state: "closed" });
    root.unmount();
  });
});

test("useExitPresence puts an unmounted overlay back, inert and closed, for its exit", async () => {
  await withDom(async (window) => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { useExitPresence } = await import("../../src/ui/usePresence");
    const Dialog = () => {
      const ref = React.useRef<HTMLDivElement>(null);
      useExitPresence(ref, 40);
      return React.createElement(
        "div",
        { ref, className: "overlay" },
        React.createElement("div", { role: "dialog", "aria-modal": "true" }),
      );
    };
    let shown = true;
    const main = window.document.querySelector("main");
    const root = createRoot(main);
    const render = () =>
      flushSync(() =>
        root.render(
          React.createElement(
            React.Fragment,
            null,
            shown && React.createElement(Dialog),
            React.createElement("p", null, "after"),
          ),
        ),
      );
    render();
    const overlay = main.querySelector(".overlay");
    assert.equal(overlay.dataset.state, "open");

    shown = false;
    render();
    await Promise.resolve();
    // Back in its place, ahead of the paragraph, for the exit.
    assert.equal(main.firstElementChild, overlay);
    assert.equal(overlay.dataset.state, "closed");
    assert.equal(overlay.hasAttribute("inert"), true);
    assert.equal(main.querySelector('[role="dialog"]'), null);
    assert.equal(main.querySelector('[aria-modal="true"]'), null);
    await until(() => !overlay.isConnected);
    assert.equal(overlay.isConnected, false);

    // Reduced motion: removed at once.
    window.document.documentElement.dataset.motion = "reduced";
    shown = true;
    render();
    shown = false;
    render();
    await Promise.resolve();
    assert.equal(main.querySelector(".overlay"), null);
    root.unmount();
  });
});

test("a web menu stays 300ms to slide away only as a sheet on a touch phone", async () => {
  await withDom(async (window) => {
    const { menuSheetExitMs } = await import("../../src/ui/Menu");
    const phone = (matches: boolean) => {
      (globalThis as { matchMedia?: unknown }).matchMedia = (
        query: string,
      ) => ({
        matches: matches && query.includes("pointer: coarse"),
      });
    };
    try {
      phone(true);
      assert.equal(menuSheetExitMs(), 0);
      window.document.documentElement.dataset.surface = "web";
      assert.equal(menuSheetExitMs(), 300);
      phone(false);
      assert.equal(menuSheetExitMs(), 0);
    } finally {
      delete (globalThis as { matchMedia?: unknown }).matchMedia;
    }
  });
});
