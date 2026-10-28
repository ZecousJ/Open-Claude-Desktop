import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteMention,
  mentionRanges,
  snapToMentions,
} from "../../src/composer/mention";

const text = 'see @src/app.ts and @"my file.md" now';
const paths = ["src/app.ts", "my file.md"];

test("tokens are found only for chosen paths, on word boundaries", () => {
  assert.deepEqual(mentionRanges(text, paths), [
    { start: 4, end: 15 },
    { start: 20, end: 33 },
  ]);
  assert.deepEqual(mentionRanges("x@src/app.ts", paths), []);
  assert.deepEqual(mentionRanges("@src/app.tsx", paths), []);
  assert.deepEqual(mentionRanges("typed @other", paths), []);
});

test("Backspace after or inside a token takes it whole", () => {
  const ranges = mentionRanges(text, paths);
  assert.deepEqual(deleteMention(text, 15, ranges, "Backspace"), {
    text: 'see  and @"my file.md" now',
    caret: 4,
  });
  assert.deepEqual(deleteMention(text, 9, ranges, "Backspace")?.caret, 4);
  assert.equal(deleteMention(text, 4, ranges, "Backspace"), null);
  assert.equal(deleteMention(text, 16, ranges, "Backspace"), null);
});

test("Delete before or inside a token takes it whole", () => {
  const ranges = mentionRanges(text, paths);
  assert.equal(
    deleteMention(text, 20, ranges, "Delete")?.text,
    "see @src/app.ts and  now",
  );
  assert.equal(deleteMention(text, 33, ranges, "Delete"), null);
});

test("a selection never splits a token", () => {
  const ranges = mentionRanges(text, paths);
  assert.deepEqual(snapToMentions(8, 8, ranges), { start: 15, end: 15 });
  assert.deepEqual(snapToMentions(4, 4, ranges), { start: 4, end: 4 });
  assert.deepEqual(snapToMentions(8, 25, ranges), { start: 4, end: 33 });
  assert.deepEqual(snapToMentions(0, 3, ranges), { start: 0, end: 3 });
  // Coming from after the token (an arrow key left), it goes to the start.
  assert.deepEqual(snapToMentions(14, 14, ranges, 15), { start: 4, end: 4 });
});
