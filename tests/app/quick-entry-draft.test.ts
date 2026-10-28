import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import zh from "../../shared/i18n/catalogs/zh-CN";
import { quickEntryPlaceholder } from "../../shared/quick-entry";

const source = readFileSync("src/quick-window/QuickEntry.tsx", "utf8");

test("Quick Entry keeps its draft when it is dismissed and shown again", () => {
  const shown = source.slice(
    source.indexOf("bridge.onShown("),
    source.indexOf("bridge.onDictation"),
  );
  assert.ok(shown.includes("--quick-viewport-height"));
  assert.ok(!shown.includes('setText("")'));
  assert.ok(!shown.includes("setImages([])"));
  // Sending still empties the field.
  assert.match(
    source,
    /\.then\(\(\) => \{\s*setText\(""\);\s*setImages\(\[\]\);/,
  );
});

test("Quick Entry's input says what it is for in the app's language", () => {
  assert.match(source, /placeholder=\{t\(quickEntryPlaceholder\)\}/);
  assert.match(source, /aria-label=\{t\(quickEntryPlaceholder\)\}/);
  assert.equal(zh[quickEntryPlaceholder], "今天有什么可以帮你？");
});
