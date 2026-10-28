import test from "node:test";
import assert from "node:assert/strict";
import { parseIdbElements } from "../../electron/simulators/ios-commands";
import { parseUiDump } from "../../electron/simulators/android-commands";
import {
  elementChatText,
  elementsAt,
  elementTitle,
} from "../../src/simulators/SimulatorInspector";
import type { SimulatorElement } from "../../shared/simulators";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InspectorPanel,
  useInspectorState,
} from "../../src/simulators/SimulatorInspector";

test("idb's describe-all becomes elements, as one array or one object per line", () => {
  const items = [
    {
      type: "Application",
      AXLabel: "MyApp",
      frame: { x: 0, y: 0, width: 393, height: 852 },
    },
    {
      type: "Button",
      AXLabel: "Sign in",
      AXUniqueId: "signIn",
      enabled: true,
      frame: { x: 20, y: 700, width: 353, height: 50 },
    },
    { type: "Other", frame: { x: 0, y: 0, width: 0, height: 10 } },
  ];
  const array = parseIdbElements(JSON.stringify(items));
  assert.equal(array.length, 2);
  assert.deepEqual(array[1], {
    type: "Button",
    label: "Sign in",
    value: undefined,
    identifier: "signIn",
    frame: { x: 20, y: 700, width: 353, height: 50 },
    depth: 1,
    enabled: true,
  });
  assert.equal(
    parseIdbElements(items.map((item) => JSON.stringify(item)).join("\n"))
      .length,
    2,
  );
});

test("uiautomator's dump becomes elements with depth, labels and pixel frames", () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" enabled="true" bounds="[0,0][1080,2400]"><node index="0" text="Sign &amp; go" resource-id="com.example:id/go" class="android.widget.Button" content-desc="" enabled="false" bounds="[40,2000][1040,2140]" /></node></hierarchy>UI hierchary dumped to: /dev/tty`;
  const elements = parseUiDump(xml);
  assert.equal(elements.length, 2);
  assert.equal(elements[0].depth, 0);
  assert.deepEqual(elements[1], {
    type: "android.widget.Button",
    label: "Sign & go",
    value: undefined,
    identifier: "com.example:id/go",
    frame: { x: 40, y: 2000, width: 1000, height: 140 },
    depth: 1,
    enabled: false,
  });
});

test("the element under a point is the smallest there; the card's title and the chat text", () => {
  const screen: SimulatorElement = {
    path: "0",
    type: "Application",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    depth: 0,
  };
  const button: SimulatorElement = {
    path: "1",
    type: "Button",
    label: "Sign in",
    identifier: "signIn",
    frame: { x: 0.1, y: 0.8, width: 0.8, height: 0.06 },
    depth: 1,
  };
  assert.deepEqual(
    elementsAt([screen, button], 0.5, 0.82).map((e) => e.path),
    ["1", "0"],
  );
  assert.deepEqual(
    elementsAt([screen, button], 0.5, 0.2).map((e) => e.path),
    ["0"],
  );
  assert.equal(elementTitle(button), "Sign in");
  assert.equal(elementTitle(screen), "Application");
  assert.equal(
    elementChatText(button, "  Make it blue "),
    'Simulator element: "Sign in" (Button, id signIn)\nMake it blue',
  );
});

test("the Properties rows and Copy info", async () => {
  const { elementProperties, elementInfoText } =
    await import("../../src/simulators/SimulatorInspector");
  const element: SimulatorElement = {
    path: "2",
    type: "Button",
    label: "Sign in",
    identifier: "signIn",
    enabled: false,
    frame: { x: 0.05, y: 0.8, width: 0.9, height: 0.06 },
    bounds: { x: 20, y: 700, width: 353, height: 50 },
    depth: 1,
  };
  assert.deepEqual(elementProperties(element), [
    ["Type", "Button"],
    ["Label", "Sign in"],
    ["Identifier", "signIn"],
    ["Frame", "20, 700, 353 × 50"],
    ["Enabled", "No"],
  ]);
  assert.equal(elementInfoText(element).split("\n")[0], "Type: Button");
});

test("the inspector exposes the accessibility tree, Properties, Copy info and Copy name", () => {
  const element: SimulatorElement = {
    path: "0",
    type: "Button",
    label: "Sign in",
    depth: 0,
    frame: { x: 0, y: 0, width: 1, height: 1 },
  };
  function SelectedInspector() {
    const state = useInspectorState();
    return createElement(InspectorPanel, {
      elements: [element],
      loading: false,
      state: { ...state, selection: { stack: [element], index: 0 } },
      onClose: () => {},
      onCopy: () => {},
    });
  }
  const markup = renderToStaticMarkup(createElement(SelectedInspector));
  assert.match(markup, /role="tree" aria-label="Accessibility tree"/);
  assert.match(markup, /aria-selected="true"/);
  assert.match(markup, /aria-label="Properties"/);
  assert.match(markup, /Copy info/);
  assert.match(markup, /aria-label="Copy name"/);
  assert.match(markup, /aria-label="Close inspector"/);
});
