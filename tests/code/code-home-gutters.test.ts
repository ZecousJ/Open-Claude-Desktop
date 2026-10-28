import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import {
  codeHomeGutter,
  useCodeHomeGutters,
} from "../../src/code-home/useCodeHomeGutters";

test("Code pane gutters update before paint at the framed tile's 560px boundary without a new fixed-position containing block", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  let width = 510,
    resize: () => void = () => {},
    disconnected = false;
  const oldWidth = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "clientWidth",
  );
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width,
  });
  const values = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  };
  const saved = new Map(
    Object.keys(values).map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  function Home() {
    const ref = useCodeHomeGutters();
    return createElement("div", { ref, id: "home" });
  }
  try {
    await act(async () => root.render(createElement(Home)));
    const node = document.querySelector<HTMLElement>("#home")!;
    assert.equal(node.style.getPropertyValue("--code-home-gutter"), "25px");
    width = 570;
    resize();
    assert.equal(node.style.getPropertyValue("--code-home-gutter"), "25px");
    width = 571;
    resize();
    assert.equal(node.style.getPropertyValue("--code-home-gutter"), "41px");
    width = 1152;
    window.dispatchEvent(new window.Event("resize"));
    assert.equal(node.style.getPropertyValue("--code-home-gutter"), "41px");
    width = 390;
    resize();
    assert.equal(node.style.getPropertyValue("--code-home-gutter"), "25px");
  } finally {
    await act(async () => root.unmount());
    assert.equal(disconnected, true);
    if (oldWidth)
      Object.defineProperty(
        window.HTMLElement.prototype,
        "clientWidth",
        oldWidth,
      );
    else Reflect.deleteProperty(window.HTMLElement.prototype, "clientWidth");
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
  const css = readFileSync("src/code-home/code-home.css", "utf8");
  assert.match(css, /var\(--code-home-gutter, 41px\)/);
  assert.doesNotMatch(css, /container-type:/);
  const main = readFileSync("src/main.tsx", "utf8");
  const load = 'await import("./code-home/native-code-home.css")';
  const nativeBlock = main.match(
    /if\s*\(surface !== "web"\)\s*\{([^}]+)\}/,
  )?.[1];
  assert.ok(nativeBlock?.includes(load));
  assert.ok(main.indexOf(load) < main.indexOf("renderer.root.render("));
});

test("Code gutters include the actual web tile inset, preserving compact 568px panes", () => {
  assert.equal(codeHomeGutter(568), 25);
  assert.equal(codeHomeGutter(570), 25);
  assert.equal(codeHomeGutter(571), 41);
  assert.equal(codeHomeGutter(611), 41);
});
