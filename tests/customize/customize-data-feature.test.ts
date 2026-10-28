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

test("Data feature shows its spreadsheet glyph on a disc", () => {
  const { document } = parseHTML(
    renderToStaticMarkup(createElement(DataFeatureArt)),
  );
  const svg = document.querySelector("svg")!;
  assert.equal(svg.getAttribute("viewBox"), "0 0 128 128");
  assert.ok(document.querySelector(".customize-data-highlight"));
  assert.ok(document.querySelector(".lucide-file-spreadsheet"));
});

test("Data picture layout and theme inks", () => {
  const css = readFileSync(
    "src/collections/customize/data-feature-art.css",
    "utf8",
  );
  assert.match(css, /width: 128px/);
  assert.match(css, /height: 128px/);
  assert.match(css, /fill: #629987/);
  assert.match(css, /fill: #bcd1ca/);
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
