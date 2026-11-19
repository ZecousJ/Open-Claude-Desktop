import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { DataFeatureArt } from "../../src/collections/customize/DataFeatureArt";
import { CustomizePage } from "../../src/collections/customize/CustomizePage";
import { defaultSettings } from "../../electron/store/store";
import { filterPlugins } from "../../src/plugins/plugin-model";
import type { PluginEntry } from "../../shared/collections-api";
import drawing from "../../src/collections/customize/spreadsheet-chart-frames.json";

test("Data feature uses the source 48-frame, 12fps drawing without invented paths", () => {
  assert.equal(drawing.width, 1200);
  assert.equal(drawing.height, 1200);
  assert.equal(drawing.frameRate, 12);
  assert.equal(drawing.frames.length, 48);
  const { document } = parseHTML(
    renderToStaticMarkup(createElement(DataFeatureArt)),
  );
  const svg = document.querySelector("svg")!;
  assert.equal(svg.getAttribute("viewBox"), "0 0 1200 1200");
  const flipbook = document.querySelector(".customize-data-flipbook")!;
  assert.match(flipbook.getAttribute("style")!, /--customize-data-span:-9400%/);
  assert.match(flipbook.getAttribute("style")!, /animation-duration:4s/);
  assert.equal(flipbook.children.length, 48);
  for (let i = 0; i < drawing.frames.length; i++) {
    const source = drawing.frames[i];
    const expected = [...source.highlight, ...source.line].map((path) =>
      path.replace(/M(-?\d+)/g, (_, x: string) => `M${Number(x) + i * 2400}`),
    );
    assert.deepEqual(
      Array.from(flipbook.children[i].querySelectorAll("path"), (p) =>
        p.getAttribute("d"),
      ),
      expected,
    );
  }
});

test("Data motion, layout, theme inks and reduced motion follow the reference", () => {
  const css = readFileSync(
    "src/collections/customize/data-feature-art.css",
    "utf8",
  );
  assert.match(css, /width: 128px/);
  assert.match(css, /height: 128px/);
  assert.match(css, /scale\(1\.2\)/);
  assert.match(css, /transform-box: view-box/);
  assert.match(css, /steps\(var\(--customize-data-steps\), jump-none\)/);
  assert.match(css, /fill: #629987/);
  assert.match(css, /fill: #bcd1ca/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /data-motion="reduced"/);
  const shell = readFileSync("src/collections/customize/customize.css", "utf8");
  assert.match(shell, /\.customize-scroll\s*\{[^}]*scrollbar-width: thin;/);
  assert.match(shell, /\.customize-feature h3\s*\{[^}]*22px\/28px/);
});

test("Skills Discover renders no static directory before the runtime catalog arrives", () => {
  const { document } = parseHTML(
    renderToStaticMarkup(
      createElement(CustomizePage, {
        settings: defaultSettings,
        onUseSkill() {},
        onOpenSettings() {},
        onConfirmRemove() {},
        onError() {},
      }),
    ),
  );
  assert.equal(document.querySelector(".customize-feature"), null);
  assert.equal(document.querySelector(".customize-directory-head"), null);
  assert.doesNotMatch(
    document.body.textContent ?? document.documentElement.textContent ?? "",
    /Included with|Most installed/,
  );
});

test("marketplace name sorting uses real titles, preserves the input and applies filters", () => {
  const list = [
    {
      id: "z@a",
      title: "Zebra",
      name: "z",
      marketplace: "a",
      category: "code",
    },
    {
      id: "b@a",
      title: "Alpha",
      name: "b",
      marketplace: "a",
      category: "code",
    },
    {
      id: "a@a",
      title: "Alpha",
      name: "a",
      marketplace: "a",
      category: "data",
    },
  ] as PluginEntry[];
  assert.deepEqual(
    filterPlugins(list, { sort: "name" }).map((p) => p.id),
    ["a@a", "b@a", "z@a"],
  );
  assert.deepEqual(
    list.map((p) => p.id),
    ["z@a", "b@a", "a@a"],
  );
  assert.deepEqual(
    filterPlugins(list, { sort: "name", category: "code", query: "ALPHA" }).map(
      (p) => p.id,
    ),
    ["b@a"],
  );
});
