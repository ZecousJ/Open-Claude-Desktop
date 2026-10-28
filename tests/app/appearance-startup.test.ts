import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import ts from "typescript";
import { useAppearance } from "../../src/settings/useAppearance";
import { defaultSettings } from "../../electron/store/store";
import type { Settings } from "../../shared/types";

test("font, text size and width are applied in the prepaint hook", () => {
  const source = readFileSync(
    new URL("../../src/settings/useAppearance.ts", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "useAppearance.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let phase = "";
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.arguments[0]?.getText(ast).includes("root.dataset.chatTextSize")
    )
      phase = node.expression.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(phase, "useLayoutEffect");
});

test("unloaded appearance preserves boot hints and loaded nondefaults apply together", async () => {
  const { window, document } = parseHTML(
    '<html data-chat-font="sans" data-chat-text-size="l" data-transcript-width="l" data-interface-font="system"><body><main></main></body></html>',
  );
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
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
  function Probe({ settings }: { settings?: Settings }) {
    useAppearance(settings);
    return null;
  }
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(() => root.render(createElement(Probe, {})));
    assert.equal(document.documentElement.dataset.chatFont, "sans");
    assert.equal(document.documentElement.dataset.chatTextSize, "l");
    await act(() =>
      root.render(
        createElement(Probe, {
          settings: {
            ...defaultSettings,
            chatFont: "serif",
            transcriptTextSize: "s",
            transcriptWidth: "m",
            interfaceFont: "dyslexic",
            codeFont: "Local Mono",
          },
        }),
      ),
    );
    assert.deepEqual(
      ["chatFont", "chatTextSize", "transcriptWidth", "interfaceFont"].map(
        (key) => document.documentElement.dataset[key],
      ),
      ["serif", "s", "m", "dyslexic"],
    );
    assert.equal(
      document.documentElement.style.getPropertyValue("--code-font-custom"),
      '"Local Mono",',
    );
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
