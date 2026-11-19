import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Anthropicon, anthropicons } from "../../src/ui/anthropicons";
import { WarningIcon } from "../../src/policy/GlobalLimitToast";

test("every local outline renders at explicit optical sizes without a missing font code", () => {
  for (const name of Object.keys(
    anthropicons,
  ) as (keyof typeof anthropicons)[]) {
    for (const size of [12, 16, 20, 24]) {
      const html = renderToStaticMarkup(
        createElement(Anthropicon, { name, size }),
      );
      assert.ok(html.includes("anthropicon"), `${name} at ${size}`);
      assert.doesNotMatch(html, /NaN|undefined/);
    }
  }
});

/**
 * The glyph paths are relative commands (m, l, h, v, q, z; work/audit/
 * relpath.py): the points they reach, absolute, and how many contours open
 * and close.
 */
function walk(d: string) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  const points: number[][] = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let command = "";
  let opened = 0;
  let closed = 0;
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    if (/[a-zA-Z]/.test(token)) {
      command = token;
      i++;
      if (command === "z" || command === "Z") {
        closed++;
        x = sx;
        y = sy;
      }
      continue;
    }
    const n = (k: number) => Number(tokens[i + k]);
    const relative = command === command.toLowerCase();
    const bx = relative ? x : 0;
    const by = relative ? y : 0;
    switch (command.toLowerCase()) {
      case "m":
        x = bx + n(0);
        y = by + n(1);
        i += 2;
        sx = x;
        sy = y;
        opened++;
        command = relative ? "l" : "L";
        points.push([x, y]);
        break;
      case "l":
        x = bx + n(0);
        y = by + n(1);
        i += 2;
        points.push([x, y]);
        break;
      case "h":
        x = bx + n(0);
        i += 1;
        points.push([x, y]);
        break;
      case "v":
        y = (relative ? y : 0) + n(0);
        i += 1;
        points.push([x, y]);
        break;
      case "q":
        points.push([bx + n(0), by + n(1)]);
        x = bx + n(2);
        y = by + n(3);
        i += 4;
        points.push([x, y]);
        break;
      default:
        throw Error(`unexpected command ${command}`);
    }
  }
  return { points, opened, closed };
}

test("the glyphs outlined from the icon font include the filled thumbs, Pause and AgentsSimple", () => {
  for (const name of [
    "ThumbsUpFilled",
    "ThumbsDownFilled",
    "Pause",
    "AgentsSimple",
  ] as const) {
    const glyph = anthropicons[name];
    assert.ok(glyph, name);
    assert.match(glyph.d, /^m[\d.]/, name);
    assert.ok(glyph.d.endsWith("z"), name);
  }
});

test("the task windows' glyphs come at the sizes they are drawn", () => {
  const sizes = {
    DotsHorizontal: 16,
    ArrowSplitRight: 16,
    Minus: 16,
    ArrowOutSquare: 16,
    X: 16,
    Hand: 14,
    Fastforward: 14,
    Warning: 14,
    MinimizeBottomRight: 20,
  } as const;
  for (const [name, size] of Object.entries(sizes)) {
    const glyph = anthropicons[name as keyof typeof sizes];
    assert.equal(glyph.size, size, name);
    assert.ok(glyph.d.endsWith("z"), name);
  }
});

test("the find bar's glyphs and the No preview file badge come at the sizes they are drawn", () => {
  const sizes = { ArrowUp: 20, ArrowDown: 20, XBase: 20, File: 24 } as const;
  for (const [name, size] of Object.entries(sizes)) {
    const glyph = anthropicons[name as keyof typeof sizes];
    assert.equal(glyph.size, size, name);
    assert.ok(glyph.d.endsWith("z"), name);
  }
});

test("every glyph is a closed outline inside its own square", () => {
  for (const [name, { size, d }] of Object.entries(anthropicons)) {
    const { points, opened, closed } = walk(d);
    assert.ok(
      points.every(
        ([x, y]) =>
          x >= -0.01 && x <= size + 0.01 && y >= -0.01 && y <= size + 0.01,
      ),
      `${name} stays on its ${size}px grid`,
    );
    assert.equal(opened, closed, `${name} closes every contour`);
  }
});

test("warning outlines scale without changing paths, colour or accessible labels", () => {
  for (const name of ["Warning", "WarningCircle"] as const) {
    for (const size of [11, 13, 14, 15, 16, 18, 20]) {
      const html = renderToStaticMarkup(
        createElement(Anthropicon, {
          name,
          size,
          className: "warning-colour",
          "aria-label": "Warning",
          style: { color: "red" },
        }),
      );
      assert.match(html, new RegExp(`width="${size}" height="${size}"`));
      const grid = anthropicons[name].size;
      assert.ok(html.includes(`viewBox="0 0 ${grid} ${grid}"`));
      assert.ok(html.includes(`d="${anthropicons[name].d}"`));
      assert.match(html, /fill="currentColor"/);
      assert.match(html, /class="anthropicon warning-colour"/);
      assert.match(html, /aria-label="Warning"/);
      assert.match(html, /role="img"/);
      assert.doesNotMatch(html, /aria-hidden/);
    }
  }
  const toast = renderToStaticMarkup(createElement(WarningIcon));
  assert.ok(toast.includes(`d="${anthropicons.Warning.d}"`));
  assert.match(toast, /global-limit-toast-icon/);
  assert.match(toast, /aria-hidden="true"/);
});
