import test from "node:test";
import assert from "node:assert/strict";
import {
  countLines,
  formatLines,
  shortenAttachmentName,
} from "../../shared/attachment-detail";

const bytes = (text: string) => new TextEncoder().encode(text);

test("a text file's lines are counted without a final line break (R-0243)", () => {
  assert.equal(countLines(bytes("")), 0);
  assert.equal(countLines(bytes("one")), 1);
  assert.equal(countLines(bytes("one\n")), 1);
  assert.equal(countLines(bytes("one\ntwo")), 2);
  assert.equal(countLines(bytes("one\ntwo\n")), 2);
  assert.equal(countLines(bytes("a\n\nb\n")), 3);
});

test("the tile says '1 line' or 'N lines'", () => {
  assert.equal(formatLines(1), "1 line");
  assert.equal(formatLines(8), "8 lines");
  assert.equal(formatLines(0), "0 lines");
});

test("a long file name is cut in the middle and keeps its ending (R-1093)", () => {
  assert.equal(shortenAttachmentName("sample-log.json"), "sample-log.json");
  const cut = shortenAttachmentName("synthetic-long-name-for-removal.txt");
  assert.equal(cut, "synthetic-lon…-removal.txt");
  assert.ok(cut.endsWith(".txt"));
});
