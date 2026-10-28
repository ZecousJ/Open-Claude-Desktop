import { test } from "node:test";
import assert from "node:assert/strict";
import { promptSegments } from "../../src/transcript/prompt-segments";

test("prompts keep Markdown literal but mark code spans and web addresses", () => {
  assert.deepEqual(
    promptSegments(
      "含**粗体**、`inline code` 和 https://example.com/a?b=1。后文",
    ),
    [
      { kind: "text", text: "含**粗体**、" },
      { kind: "code", text: "inline code" },
      { kind: "text", text: " 和 " },
      // The link runs to the next whitespace, through CJK text.
      { kind: "link", text: "https://example.com/a?b=1。后文" },
    ],
  );
  assert.deepEqual(promptSegments("See (https://example.com/x)."), [
    { kind: "text", text: "See (" },
    { kind: "link", text: "https://example.com/x" },
    { kind: "text", text: ")." },
  ]);
  assert.deepEqual(promptSegments("no ` pair"), [
    { kind: "text", text: "no ` pair" },
  ]);
});
