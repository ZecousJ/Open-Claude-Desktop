import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import UnifiedSearch, {
  searchSections,
  searchableLength,
  type SearchItem,
} from "../../src/collections/customize/UnifiedSearch";

const item = (
  key: string,
  kind: SearchItem["kind"],
  name: string,
  yours: boolean,
): SearchItem => ({ key, kind, name, yours, open: () => {} });

const items = [
  item("a", "skill", "PDF reader", true),
  item("b", "skill", "PDF writer", false),
  item("c", "plugin", "PDF tools", false),
  item("d", "connector", "PDF cloud", false),
  item("e", "plugin", "Spreadsheets", true),
];

test("search sections: yours, this page's catalog, the others, from two characters", () => {
  const sections = searchSections(items, "pdf", "skills");
  assert.deepEqual(
    sections.yours.map((entry) => entry.key),
    ["a"],
  );
  assert.deepEqual(
    sections.inPage.map((entry) => entry.key),
    ["b"],
  );
  assert.deepEqual(
    sections.more.map((entry) => entry.key),
    ["c", "d"],
  );
  assert.equal(sections.keepTyping, false);
  const short = searchSections(items, "p", "skills");
  assert.equal(short.keepTyping, true);
  assert.deepEqual(short.more, []);
  assert.equal(searchableLength("a-"), 1);
  // On Plugins, Yours lists plugins only.
  assert.deepEqual(
    searchSections(items, "s", "plugins").yours.map((entry) => entry.key),
    ["e"],
  );
});

test("the results show the heading, sections with Show more, and the notes", () => {
  const many = Array.from({ length: 8 }, (_, index) =>
    item(`x${index}`, "plugin", `Data ${index}`, false),
  );
  const html = renderToStaticMarkup(
    createElement(UnifiedSearch, {
      query: "data",
      page: "plugins",
      items: many,
    }),
  );
  assert.match(html, /Results matching “data”/);
  assert.match(html, /In Plugins/);
  assert.match(html, /Show more/);
  assert.equal((html.match(/customize-row-main/g) ?? []).length, 5);
  const short = renderToStaticMarkup(
    createElement(UnifiedSearch, { query: "d", page: "plugins", items: many }),
  );
  assert.match(short, /Keep typing to search everything you can add\./);
});
