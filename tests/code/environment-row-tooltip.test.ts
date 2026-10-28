import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import {
  EnvironmentPath,
  EnvironmentStartCard,
} from "../../src/composer/EnvironmentStartCard";
import { TooltipGroup } from "../../src/ui/Tooltip";
import { tooltipOrigin, tooltipPosition } from "../../src/ui/tooltip-position";
import { routineDom } from "../support/routine-dom";

test("source path content preserves slash segments, LTR order and literal text", () => {
  for (const path of [
    "~/Developer/Claudex",
    "C:\\Users\\fixture\\repo",
    "/tmp/a & <unsafe>/repo/",
  ]) {
    const doc = parseHTML(
      renderToStaticMarkup(createElement(EnvironmentPath, { path })),
    ).document;
    const outer = doc.querySelector("[dir=ltr]")!;
    assert.equal(outer.textContent, path);
    assert.deepEqual(
      [...outer.children].map((node) => node.textContent),
      path.split(/(?<=[\\/])/),
    );
    assert.equal(doc.querySelector("unsafe"), null);
    for (const node of outer.children)
      assert.match(
        node.getAttribute("style") ?? "",
        /inline-block.*max-width:100%.*white-space:pre-wrap/,
      );
  }
});

test("path tooltip top/start positioning retains4px gap and window collision bounds", () => {
  const anchor = { left: 400, right: 712, top: 300, bottom: 332 };
  const at = tooltipPosition(
    anchor,
    { width: 145, height: 24 },
    { width: 1280, height: 720 },
    "above-start",
  );
  assert.deepEqual(at, { left: 400, top: 272 });
  assert.equal(
    tooltipOrigin(anchor, at, { width: 145, height: 24 }, "above-start"),
    "145px 100%",
  );
  assert.deepEqual(
    tooltipPosition(
      { left: 280, right: 380, top: 80, bottom: 112 },
      { width: 300, height: 60 },
      { width: 390, height: 844 },
      "above-start",
    ),
    { left: 82, top: 16 },
  );
});

test("selected and unselected real environment rows share rich tooltips and do not choose on hover", async () => {
  const dom = await routineDom({
    appEnvironment: async () => ({
      version: "0",
      platform: "darwin",
      osVersion: "0",
      arch: "arm64",
      home: "/Users/fixture",
    }),
  });
  const globals = new Map(
    ["innerWidth", "innerHeight"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "innerWidth", {
    configurable: true,
    value: 1280,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    configurable: true,
    value: 720,
  });
  const proto = dom.window.HTMLElement.prototype;
  const oldRect = Object.getOwnPropertyDescriptor(
    proto,
    "getBoundingClientRect",
  );
  const oldComputed = Object.getOwnPropertyDescriptor(
    dom.window,
    "getComputedStyle",
  );
  Object.defineProperty(dom.window, "getComputedStyle", {
    configurable: true,
    value: () => ({ width: "145px", height: "24px" }),
  });
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      return this.classList.contains("chrome-tooltip")
        ? {
            left: 0,
            right: 142.1,
            top: 0,
            bottom: 23.52,
            width: 142.1,
            height: 23.52,
          }
        : {
            left: 400,
            right: 712,
            top: 300,
            bottom: 332,
            width: 312,
            height: 32,
          };
    },
  });
  let chosen = 0;
  const tick = () =>
    act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  try {
    await dom.render(
      createElement(TooltipGroup, {
        delay: 0,
        closeDelay: 0,
        children: createElement(EnvironmentStartCard, {
          rows: [
            {
              id: "selected",
              name: "Selected",
              detail: "/Users/fixture/Developer/Claudex",
              detailKind: "local-path",
              onSelect: () => {
                chosen++;
              },
            },
            {
              id: "other",
              name: "Other",
              detail: "/Users/other/repo",
              detailKind: "local-path",
              onSelect: () => {
                chosen++;
              },
            },
            {
              id: "host",
              name: "Host",
              detail: "builder@example.test:2222",
              detailKind: "text",
              onSelect: () => {
                chosen++;
              },
            },
          ],
          selectedId: "selected",
          open: false,
          onChoose() {},
        }),
      }),
    );
    const selected = dom.document.querySelector(
      "[aria-current=true] [data-testid=start-card-environment]",
    )!;
    assert.equal(selected.tagName, "DIV");
    assert.equal(selected.getAttribute("title"), null);
    assert.equal(
      selected.querySelector(".sr-only")?.textContent,
      "~/Developer/Claudex",
    );
    await dom.event(selected, "pointerover", {
      pointerType: "mouse",
      relatedTarget: null,
    });
    await tick();
    let tip = dom.document.querySelector<HTMLElement>("[role=tooltip]")!;
    assert.equal(tip.textContent, "~/Developer/Claudex");
    assert.equal(
      tip.querySelector("[dir=ltr]")?.textContent,
      "~/Developer/Claudex",
    );
    assert.match(tip.getAttribute("style") ?? "", /480px/);
    assert.equal(tip.style.left, "400px");
    assert.equal(tip.style.top, "272px");
    const other = dom.document.querySelectorAll(
      "button[data-testid=start-card-environment]",
    )[0];
    await dom.event(other, "pointerover", {
      pointerType: "mouse",
      relatedTarget: null,
    });
    await tick();
    tip = [
      ...dom.document.querySelectorAll<HTMLElement>("[role=tooltip]"),
    ].find((node) => node.getAttribute("data-open") === "true")!;
    assert.equal(tip.textContent, "/Users/other/repo");
    assert.equal(chosen, 0);
    await dom.event(other, "click");
    assert.equal(chosen, 1);
    const host = dom.document.querySelectorAll(
      "button[data-testid=start-card-environment]",
    )[1];
    await dom.event(host, "pointerover", {
      pointerType: "mouse",
      relatedTarget: null,
    });
    await tick();
    tip = [
      ...dom.document.querySelectorAll<HTMLElement>("[role=tooltip]"),
    ].find((node) => node.getAttribute("data-open") === "true")!;
    assert.equal(tip.textContent, "builder@example.test:2222");
    assert.equal(tip.querySelector("[dir=ltr]"), null);
  } finally {
    await dom.clean();
    if (oldRect) Object.defineProperty(proto, "getBoundingClientRect", oldRect);
    else Reflect.deleteProperty(proto, "getBoundingClientRect");
    if (oldComputed)
      Object.defineProperty(dom.window, "getComputedStyle", oldComputed);
    else Reflect.deleteProperty(dom.window, "getComputedStyle");
    for (const [key, descriptor] of globals)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
