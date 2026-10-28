import test from "node:test";
import assert from "node:assert/strict";
import { relativeTime } from "../../src/ui/RelativeTime";
import { thoughtLabel } from "../../src/transcript/thought-label";
import { markdownToHtml, withHardBreaks } from "../../src/ui/markdown-html";

const now = Date.UTC(2026, 9, 12, 12, 0, 0);
const ago = (seconds: number) => now - seconds * 1000;

test("a time reads as the original writes it: rounded, yesterday, then a date", () => {
  assert.equal(relativeTime(ago(5), now), "just now");
  assert.equal(relativeTime(ago(59), now), "just now");
  assert.equal(relativeTime(ago(60), now), "1 minute ago");
  // Rounded to the nearest, not cut down: 89s is a minute, 90s is two.
  assert.equal(relativeTime(ago(89), now), "1 minute ago");
  assert.equal(relativeTime(ago(90), now), "2 minutes ago");
  assert.equal(relativeTime(ago(3600 * 5), now), "5 hours ago");
  assert.equal(relativeTime(ago(86400), now), "yesterday");
  assert.equal(relativeTime(ago(86400 * 3), now), "3 days ago");
  // From a week on it is a date; the year only when it is not this one.
  assert.equal(relativeTime(ago(86400 * 7), now), "Oct 5");
  assert.equal(
    relativeTime(Date.UTC(2025, 9, 5, 12, 0, 0), now),
    "Oct 5, 2025",
  );
  // A clock ahead of the stored time is not the future.
  assert.equal(relativeTime(now + 5000, now), "just now");
  assert.equal(relativeTime(Number.NaN, now), "");
});

test("thinking time uses seconds, minutes and hours", () => {
  assert.equal(thoughtLabel(42), "Thought for 42s");
  assert.equal(thoughtLabel(59.6), "Thought for 1m");
  assert.equal(thoughtLabel(125), "Thought for 2m 5s");
  assert.equal(thoughtLabel(180), "Thought for 3m");
  assert.equal(thoughtLabel(3600), "Thought for 1h");
  assert.equal(thoughtLabel(3840), "Thought for 1h 4m");
  assert.equal(thoughtLabel(7200 + 59), "Thought for 2h");
});

test("a reply copies as rich text with its line breaks kept", async () => {
  assert.equal(withHardBreaks("a\nb\n\nc"), "a  \nb\n\nc");
  assert.equal(
    withHardBreaks("```\nx\ny\n```\nz\nw"),
    "```\nx\ny\n```\nz  \nw",
  );
  const html = await markdownToHtml(
    "# Title\n\nSome **bold** text\nsecond line\n\n- one\n- two\n\n```js\nconst a = 1;\n```",
  );
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong> text<br\/>\s*second line/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<pre><code class="language-js">const a = 1;/);
  const table = await markdownToHtml(
    "| a | b |\n| :-- | --: |\n| 1 | [x](https://x.example/?a=1&b=2) |\n\n- [x] done",
  );
  assert.match(table, /<table><thead><tr><th style="text-align:left">a<\/th>/);
  assert.match(table, /<a href="https:\/\/x\.example\/\?a=1&amp;b=2">x<\/a>/);
  assert.match(table, /<input[^>]*type="checkbox"[^>]*checked/);
  // Raw HTML in a reply stays text.
  assert.doesNotMatch(await markdownToHtml("<script>x</script>"), /<script>/);
});
