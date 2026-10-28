import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { registerNotice } from "../../src/ui/notice-stack";

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
});

function page(rects: Record<string, ReturnType<typeof box>>) {
  const { window, document } = parseHTML(
    '<html><body><div id="a"></div><div id="b"></div><div id="c" class="composer-wrap"></div></body></html>',
  );
  window.innerWidth = 1440;
  window.innerHeight = 900;
  window.getComputedStyle = (() => ({
    display: "block",
    visibility: "visible",
  })) as unknown as typeof window.getComputedStyle;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rects[this.id] ?? box(0, 0, 0, 0);
  };
  return document;
}

test("a second notice rises above the first, and returns when the first goes", () => {
  const document = page({
    a: box(1064, 840, 360, 44),
    b: box(1064, 840, 360, 60),
  });
  const a = document.getElementById("a")!;
  const b = document.getElementById("b")!;
  const leaveA = registerNotice(a);
  assert.equal(a.style.getPropertyValue("--notice-lift"), "0px");
  const leaveB = registerNotice(b);
  // 16px + the first's 44px + an 8px gap.
  assert.equal(b.style.getPropertyValue("--notice-lift"), "52px");
  leaveA();
  leaveB();
  assert.ok(!b.style.getPropertyValue("--notice-lift"));
});

test("notices rise above a composer near the bottom that they overlap sideways", () => {
  const document = page({
    a: box(1064, 840, 360, 44),
    c: box(500, 752, 768, 132),
  });
  const a = document.getElementById("a")!;
  const leave = registerNotice(a);
  // The composer's top is 752: 900 - 752 = 148, plus the 16px margin.
  assert.equal(a.style.getPropertyValue("--notice-lift"), "148px");
  leave();
});
