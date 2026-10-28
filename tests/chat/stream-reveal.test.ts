import test from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import {
  REVEAL_TIMING,
  StreamReveal,
  rehypeStreamReveal,
} from "../../src/ui/stream-reveal";

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

/** A scheduler on a clock the test moves. */
function scheduler(mode: "word" | "phrase" = "word") {
  const clock = { now: 0 };
  return { clock, reveal: new StreamReveal(mode, () => clock.now) };
}

const render = (reveal: StreamReveal, source: string) => {
  reveal.sync(source);
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeStreamReveal, { reveal });
  return processor.runSync(processor.parse(source)) as unknown as Node;
};

/** The fading spans in document order: [text, delay]. */
const fading = (node: Node): [string, number][] =>
  (node.children ?? []).flatMap((child) => {
    const classes = (child.properties?.className as string[]) ?? [];
    if (child.tagName === "span" && classes.length) {
      const delay = /animation-delay:(\d+)ms/.exec(
        String(child.properties?.style ?? ""),
      );
      return [
        [child.children![0].value!, delay ? Number(delay[1]) : 0] as [
          string,
          number,
        ],
      ];
    }
    return fading(child);
  });

test("words fade in chunks of whole words, at most 16 characters in one delivery", () => {
  const { reveal } = scheduler();
  const tree = render(reveal, "The quick brown fox jumps over the lazy dog");
  const chunks = fading(tree);
  assert.ok(chunks.length > 1);
  for (const [text] of chunks) {
    // Whole words: every chunk ends at a word's end (or the text's).
    assert.match(text, /\S\s*$/);
    assert.ok(text.trimEnd().length <= REVEAL_TIMING.samePassChars, text);
  }
  assert.equal(
    chunks.map(([text]) => text).join(""),
    "The quick brown fox jumps over the lazy dog",
  );
});

test("each chunk starts 2.5ms per character after the one before, never more than 600ms ahead", () => {
  const { reveal } = scheduler();
  const chunks = fading(render(reveal, "alpha beta gamma delta epsilon zeta"));
  const delays = chunks.map(([, delay]) => delay);
  for (let i = 1; i < delays.length; i++)
    assert.ok(delays[i] > delays[i - 1], `${delays}`);
  // The first chunk waits for its first word's characters.
  assert.equal(delays[0], Math.round("alpha ".length * 2.5));
  const long = scheduler();
  const many = fading(render(long.reveal, "word ".repeat(400)));
  assert.ok(
    many.every(([, delay]) => delay <= REVEAL_TIMING.maxLeadMs),
    "lead is capped",
  );
});

test("a word keeps its chunk as the text grows; text seen before is not re-wrapped", () => {
  const { clock, reveal } = scheduler();
  const first = fading(render(reveal, "Hello there"));
  clock.now += 50;
  const second = fading(render(reveal, "Hello there friend"));
  // The chunk is under 100ms old, so it takes "friend" too and keeps its
  // delay: the span grows instead of starting over.
  assert.equal(first.length, 1);
  assert.deepEqual(second, [["Hello there friend", first[0][1]]]);
  clock.now += 1000;
  // Long finished: the old chunks are plain spans (no class) now.
  const later = fading(render(reveal, "Hello there friend, again"));
  assert.ok(later.every(([text]) => !text.includes("Hello")));
});

test("a chunk closes once it is 100ms old and a new word starts", () => {
  const { clock, reveal } = scheduler();
  render(reveal, "One");
  clock.now += 120;
  const chunks = fading(render(reveal, "One two"));
  // "two" is a new chunk with its own delay.
  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map(([text]) => text),
    ["One ", "two"],
  );
});

test("text arriving faster than 1.6 characters a millisecond appears without a fade", () => {
  const { clock, reveal } = scheduler();
  let text = "";
  // Two 100ms windows in a row at 3 characters a millisecond.
  for (let i = 0; i < 3; i++) {
    text += "fastword ".repeat(34);
    clock.now += 100;
    reveal.sync(text);
  }
  text += "tail words here";
  clock.now += 10;
  const tree = render(reveal, text);
  const chunks = fading(tree);
  assert.ok(
    chunks.every(([t]) => !t.includes("tail")),
    "the newest words are plain text",
  );
});

test("phrase mode: one chunk per delivery, no stagger", () => {
  const { clock, reveal } = scheduler("phrase");
  const first = fading(render(reveal, "Several words arrive together"));
  assert.deepEqual(first, [["Several words arrive together", 0]]);
  clock.now += 150;
  const second = fading(
    render(reveal, "Several words arrive together, then more"),
  );
  // The space after "together," belongs to that word, already shown.
  assert.deepEqual(second.at(-1), ["then more", 0]);
  assert.equal(reveal.fadeMs, 500);
});

test("code keeps its text", () => {
  const { reveal } = scheduler();
  const chunks = fading(render(reveal, "Use `npm test` and **bold** text"));
  assert.ok(chunks.every(([text]) => !text.includes("npm test")));
  assert.ok(chunks.some(([text]) => text.includes("bold")));
});

test("rewritten text shows at once", () => {
  const { clock, reveal } = scheduler();
  render(reveal, "First version of the text");
  clock.now += 20;
  const tree = render(reveal, "Second");
  const chunks = fading(tree);
  assert.ok(chunks.every(([text]) => text !== "First "));
});
