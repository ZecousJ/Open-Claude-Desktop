import test from "node:test";
import assert from "node:assert/strict";
import {
  guessLanguage,
  pickVoice,
  speakableText,
  speechChunks,
} from "../../src/voice/speech";

test("a reply is read as plain speech", () => {
  const md = [
    "# Title",
    "Some **bold** and `code` and a [link](https://x.com/a) here.",
    "```js",
    "const a = 1;",
    "```",
    "- one",
    "1. two",
    "> quoted",
    "| a | b |",
    "| --- | --- |",
    "See https://example.com now.",
  ].join("\n");
  const text = speakableText(md);
  assert.doesNotMatch(text, /const a|```|\*\*|https|\[|#|---/);
  assert.match(text, /Title/);
  assert.match(text, /Some bold and code and a link here\./);
  assert.match(text, /one\ntwo\nquoted/);
  assert.equal(speakableText("```\nunfinished"), "");
});

test("speech is cut at sentence ends and never over the limit", () => {
  assert.deepEqual(speechChunks("One. Two! Three?"), ["One. Two! Three?"]);
  const long = Array.from(
    { length: 30 },
    (_, i) => `Sentence number ${i}.`,
  ).join(" ");
  const chunks = speechChunks(long, 100);
  assert.ok(chunks.length > 4);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), long);
  const blob = "word ".repeat(100).trim();
  assert.ok(speechChunks(blob, 50).every((c) => c.length <= 50));
  assert.deepEqual(speechChunks("你好。今天怎么样？"), ["你好。今天怎么样？"]);
  assert.deepEqual(speechChunks("First\n\nSecond"), ["First", "Second"]);
  assert.deepEqual(speechChunks(""), []);
});

test("the language follows the script of the text", () => {
  assert.equal(guessLanguage("Hello there"), "en-US");
  assert.equal(guessLanguage("你好，今天过得怎么样"), "zh-CN");
  assert.equal(guessLanguage("こんにちは"), "ja-JP");
  assert.equal(guessLanguage("안녕하세요"), "ko-KR");
  assert.equal(guessLanguage("Use the 中 character"), "en-US");
});

test("the chosen voice is used only where it speaks the language", () => {
  const voices = [
    { name: "Alex", lang: "en-US", default: true },
    { name: "Daniel", lang: "en-GB", localService: true },
    { name: "Tingting", lang: "zh-CN", localService: true },
    { name: "Sinji", lang: "zh-HK" },
  ];
  assert.equal(pickVoice(voices, "en-US", "Daniel")?.name, "Daniel");
  assert.equal(pickVoice(voices, "zh-CN", "Daniel")?.name, "Tingting");
  assert.equal(pickVoice(voices, "en-US")?.name, "Alex");
  assert.equal(pickVoice(voices, "zh-CN", "Missing")?.name, "Tingting");
  assert.equal(pickVoice(voices, "ja-JP"), undefined);
  assert.equal(pickVoice([], "en-US"), undefined);
});
