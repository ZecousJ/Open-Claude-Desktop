import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { desktopHost, webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { ContextRing } from "../../src/composer/ContextRing";

function render(web: boolean, draft: boolean, fraction = 0.5) {
  const { document } = parseHTML(
    renderToStaticMarkup(
      createElement(
        HostContext.Provider,
        { value: web ? webHost : desktopHost },
        createElement(ContextRing, {
          usage: { used: 50, window: 100, fraction, draft },
        }),
      ),
    ),
  );
  return document;
}

test("web Code draft draws its actual 14px SVG with r6 and a 2px stroke", () => {
  const document = render(true, true);
  const svg = document.querySelector(".context-ring svg")!;
  assert.equal(svg.getAttribute("width"), "14");
  assert.equal(svg.getAttribute("height"), "14");
  assert.equal(svg.getAttribute("viewBox"), "0 0 14 14");
  for (const circle of svg.querySelectorAll("circle")) {
    assert.equal(circle.getAttribute("cx"), "7");
    assert.equal(circle.getAttribute("cy"), "7");
    assert.equal(circle.getAttribute("r"), "6");
    assert.equal(circle.getAttribute("stroke-width"), "2");
  }
  const arc = svg.querySelector(".context-ring-arc")!;
  const [filled, circumference] = arc
    .getAttribute("stroke-dasharray")!
    .split(" ")
    .map(Number);
  assert.equal(circumference, 12 * Math.PI);
  assert.equal(filled, circumference / 2);
  assert.equal(arc.getAttribute("transform"), "rotate(-90 7 7)");
  // No session, no context: the draft ring is just Usage, and with no
  // account there is no popover to open.
  const ring = document.querySelector('[role="button"]')!;
  assert.equal(ring.getAttribute("aria-label"), "Usage");
  assert.equal(ring.getAttribute("aria-haspopup"), null);
  assert.match(
    render(true, false)
      .querySelector('[role="button"]')!
      .getAttribute("aria-label")!,
    /50% of context used/,
  );
});

test("native draft and opened web session keep the existing 12px ring geometry", () => {
  for (const [web, draft] of [
    [false, true],
    [false, false],
    [true, false],
  ]) {
    const svg = render(web, draft).querySelector(".context-ring svg")!;
    assert.equal(svg.getAttribute("viewBox"), "0 0 12 12");
    assert.equal(svg.getAttribute("width"), "12");
    assert.equal(svg.querySelector("circle")!.getAttribute("r"), "5");
    assert.equal(svg.querySelector("circle")!.getAttribute("cx"), "6");
  }
  assert.equal(render(true, true, 0).querySelector(".context-ring-arc"), null);
});
