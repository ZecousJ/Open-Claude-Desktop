import test from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import {
  composeTargets,
  relativeBucket,
} from "../../src/collections/search/search-model";
import { SearchPaletteHead } from "../../src/collections/search/SearchPaletteHead";
import type { SearchPaletteHeadProps } from "../../src/collections/search/SearchPaletteHead";
import { ResultsSkeleton } from "../../src/collections/search/SearchPaletteView";

test("a row's time follows the live buckets: Just now, Past hour, then days, and nothing past a year", () => {
  const now = new Date(2026, 9, 20, 15).getTime();
  assert.equal(relativeBucket(now - 60_000, now), "Just now");
  assert.equal(relativeBucket(now - 299_999, now), "Just now");
  assert.equal(relativeBucket(now - 300_000, now), "Past hour");
  assert.equal(relativeBucket(now - 3_599_999, now), "Past hour");
  assert.equal(relativeBucket(now - 2 * 3_600_000, now), "Today");
  assert.equal(relativeBucket(now - 20 * 3_600_000, now), "Yesterday");
  assert.equal(relativeBucket(now - 400 * 86_400_000, now), null);
  assert.equal(relativeBucket(Number.NaN, now), null);
});

test("Compose can start a session in the current mode, and a Code session from Chat", () => {
  assert.deepEqual(
    composeTargets("chat").map((row) => [row.title, row.mode]),
    [
      ["New session", "chat"],
      ["New Code session", "code"],
    ],
  );
  assert.deepEqual(
    composeTargets("code").map((row) => row.mode),
    ["code"],
  );
});

const head = (entrypoint: "default" | "search" | "actions") => {
  const props: SearchPaletteHeadProps = {
    activeIndex: 0,
    deeper: { hits: undefined, titlesOnly: false, pending: false },
    entrypoint,
    filterLabelId: "f",
    filterOptions: [],
    filters: {},
    input: createRef<HTMLInputElement>(),
    onClose() {},
    onEntrypointChange() {},
    onQueryChange() {},
    picker: undefined,
    placeholder: "Search",
    query: "",
    rows: [],
    searchKeys() {},
    setActive() {},
    setFilters() {},
  };
  return parseHTML(
    renderToStaticMarkup(createElement(SearchPaletteHead, props)),
  ).document;
};

test("the head shows the Search glyph in Search mode and a keyboard chip with a clear cross in Actions mode", () => {
  const search = head("search");
  assert.equal(
    search.querySelector(".search-mode-glyph")?.getAttribute("aria-label"),
    "Search mode",
  );
  assert.equal(search.querySelector(".search-mode-chip"), null);
  const actions = head("actions");
  const chip = actions.querySelector(".search-mode-chip")!;
  assert.equal(
    chip.querySelector("[aria-label='Actions mode']") !== null,
    true,
  );
  assert.equal(chip.querySelectorAll("button").length, 1);
  assert.equal(
    chip.querySelector("button")?.getAttribute("aria-label"),
    "Clear filter",
  );
  // The old trailing cross is gone: only the chip's and Close remain.
  assert.equal(
    actions.querySelectorAll(".search-palette-head > button").length,
    1,
  );
  const plain = head("default");
  assert.equal(plain.querySelector(".search-mode-glyph"), null);
  assert.equal(plain.querySelector(".search-mode-chip"), null);
});

test("the loading results are 13 title rows under a heading, or 9 rows with a snippet line while searching", () => {
  const rows = (searching: boolean) =>
    parseHTML(
      renderToStaticMarkup(createElement(ResultsSkeleton, { searching })),
    ).document;
  const idle = rows(false);
  assert.equal(idle.querySelectorAll(".search-skeleton-row").length, 13);
  assert.ok(idle.querySelector(".search-skeleton-heading"));
  assert.equal(idle.querySelectorAll(".search-skeleton-row.snippet").length, 0);
  const searching = rows(true);
  assert.equal(searching.querySelectorAll(".search-skeleton-row").length, 9);
  assert.equal(
    searching.querySelectorAll(".search-skeleton-row.snippet").length,
    9,
  );
  assert.equal(searching.querySelector(".search-skeleton-heading"), null);
});
