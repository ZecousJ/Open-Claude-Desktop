import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/transcript/useTranscriptScroll.ts", "utf8");
const css = readFileSync("src/transcript/turn-layout.css", "utf8");

test("a followed transcript scrolls to its end, with no room reserved under the latest turn", () => {
  assert.match(source, /el\.scrollHeight - el\.clientHeight/);
  assert.doesNotMatch(source, /transcript-tail-space/);
  assert.doesNotMatch(css, /transcript-tail-space/);
});
