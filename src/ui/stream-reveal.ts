/**
 * How a streaming reply's words appear.
 *
 * - "word": words are grouped into chunks of whole words, at most 16 characters
 *   while one delivery is laid out and up to 48 when later deliveries join a
 *   chunk that is still open. Each chunk fades in over 200ms, starting 2.5ms
 *   per character after the one before it, but never more than 600ms ahead of
 *   now.
 * - "phrase": everything that arrives within 100ms is one chunk, fading in over
 *   500ms with no stagger.
 *
 * A chunk closes once it is 100ms old and the next delivery starts a new word.
 * While text arrives faster than 1.6 characters a millisecond (over two 100ms
 * windows in a row; it stays fast until it has been slower for 400ms) there is
 * no stagger and chunks that would start at once appear without a fade: too
 * fast to fade.
 */
export type RevealMode = "word" | "phrase";

export interface RevealChunk {
  /** When its fade starts, after the chunk was laid out. */
  delayMs: number;
  /** When its fade ends (the scheduler's clock). */
  endsAt: number;
  /** The sync pass that opened it. */
  pass: number;
  chars: number;
  /** Shown without a fade (too fast, or the text was rewritten). */
  done: boolean;
}

export const REVEAL_TIMING = {
  wordFadeMs: 200,
  phraseFadeMs: 500,
  /** How long a finished reply keeps its fading spans before it renders plain. */
  wordSettleMs: 1000,
  phraseSettleMs: 700,
  perCharMs: 2.5,
  maxLeadMs: 600,
  samePassChars: 16,
  laterPassChars: 48,
  closeAfterMs: 100,
  fastCharsPerMs: 1.6,
  fastHoldMs: 400,
} as const;

export class StreamReveal {
  readonly mode: RevealMode;
  readonly fadeMs: number;
  readonly settleMs: number;
  private readonly now: () => number;
  private readonly chunks = new Map<string, RevealChunk>();
  private open: RevealChunk | null = null;
  private openedAt = 0;
  private lastAssigned = 0;
  private pass = 0;
  private text = "";
  private tooFast = false;
  private speed: { since: number; length: number; fastAt: number };

  constructor(mode: RevealMode, now: () => number = () => performance.now()) {
    this.mode = mode;
    this.now = now;
    this.fadeMs =
      mode === "phrase" ? REVEAL_TIMING.phraseFadeMs : REVEAL_TIMING.wordFadeMs;
    this.settleMs =
      mode === "phrase"
        ? REVEAL_TIMING.phraseSettleMs
        : REVEAL_TIMING.wordSettleMs;
    this.speed = { since: now(), length: 0, fastAt: -Infinity };
  }

  /** Called once per render with the whole text so far. */
  sync(text: string) {
    const at = this.now();
    this.pass += 1;
    const { since, length, fastAt } = this.speed;
    if (at - since >= REVEAL_TIMING.closeAfterMs) {
      // Once fast, it takes a slower rate (75%) to count as slow again.
      const limit = REVEAL_TIMING.fastCharsPerMs * (this.tooFast ? 0.75 : 1);
      const fast = (text.length - length) / (at - since) > limit;
      this.tooFast = fast
        ? this.tooFast || fastAt === since
        : this.tooFast && at - fastAt < REVEAL_TIMING.fastHoldMs;
      this.speed = {
        since: at,
        length: text.length,
        fastAt: fast ? at : fastAt,
      };
    }
    if (text.startsWith(this.text)) {
      const added = text.slice(this.text.length);
      const startsWord =
        this.mode === "phrase"
          ? added !== ""
          : /\s\S/.test(this.text.slice(-1) + added);
      if (
        this.open &&
        at - this.openedAt >= REVEAL_TIMING.closeAfterMs &&
        startsWord
      )
        this.close();
    } else {
      // Rewritten text: whatever was fading is shown as it is.
      for (const chunk of this.chunks.values()) chunk.done = true;
      this.close();
    }
    this.text = text;
  }

  /** The chunk that shows `length` characters first seen under `key`. */
  reveal(key: string, length: number): RevealChunk {
    const known = this.chunks.get(key);
    if (known) return known;
    const at = this.now();
    let chunk = this.open;
    const { perCharMs, maxLeadMs } = REVEAL_TIMING;
    if (this.mode === "phrase") {
      if (!chunk) {
        this.openedAt = at;
        chunk = this.start(0);
      }
    } else if (
      !chunk ||
      chunk.chars + length >
        (chunk.pass === this.pass
          ? REVEAL_TIMING.samePassChars
          : REVEAL_TIMING.laterPassChars)
    ) {
      const due =
        Math.max(at, this.lastAssigned) +
        (this.tooFast ? 0 : length * perCharMs);
      const capped = Math.min(due, at + maxLeadMs);
      if (!chunk) this.openedAt = at;
      chunk = this.start(Math.round(capped - at));
      this.lastAssigned = capped;
    } else if (!this.tooFast) {
      this.lastAssigned = Math.min(
        this.lastAssigned + length * perCharMs,
        at + maxLeadMs,
      );
    }
    chunk.endsAt = Math.max(chunk.endsAt, at + chunk.delayMs + this.fadeMs);
    chunk.chars += length;
    this.chunks.set(key, chunk);
    return chunk;
  }

  /** The chunk has finished fading (or never faded). */
  settled(chunk: RevealChunk) {
    return chunk.done || this.now() >= chunk.endsAt;
  }

  private start(delayMs: number) {
    this.open = {
      delayMs,
      endsAt: 0,
      pass: this.pass,
      chars: 0,
      done: this.tooFast && delayMs === 0,
    };
    return this.open;
  }

  private close() {
    this.open = null;
  }
}

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

/** A word and the spaces after it (leading spaces join the first word). */
const WORD = /(?:^\s+)?\S+\s*/g;

/**
 * Rehype plugin: wraps a streaming reply's words in fading spans, keyed by
 * where each word starts in the Markdown source, so a word keeps its chunk
 * (and its span keeps its place among its siblings) on every later render.
 * A chunk that is still fading is `span.stream-word` (or `.stream-phrase`)
 * with its delay; once faded it stays a plain span, so the spans after it
 * keep their React keys; a chunk that never faded is plain text. Code keeps
 * its text. A text node whose value does not map one to one onto its source
 * (escapes, entities) is one word.
 */
export function rehypeStreamReveal(options: { reveal: StreamReveal }) {
  const { reveal } = options;
  const className = reveal.mode === "phrase" ? "stream-phrase" : "stream-word";
  const span = (chunk: RevealChunk, value: string): HastNode => ({
    type: "element",
    tagName: "span",
    properties: reveal.settled(chunk)
      ? {}
      : {
          className: [className],
          ...(chunk.delayMs > 0
            ? { style: `animation-delay:${chunk.delayMs}ms` }
            : {}),
        },
    children: [{ type: "text", value }],
  });
  const wrap = (node: HastNode, out: HastNode[]) => {
    const value = node.value ?? "";
    const start = node.position!.start!.offset!;
    const end = node.position!.end!.offset!;
    const words =
      value.length === end - start
        ? [...value.matchAll(WORD)].map((match) => ({
            at: start + match.index,
            text: match[0],
          }))
        : [{ at: start, text: value }];
    let run: { chunk: RevealChunk; text: string } | undefined;
    const flush = () => {
      if (!run) return;
      out.push(
        run.chunk.done
          ? { type: "text", value: run.text }
          : span(run.chunk, run.text),
      );
      run = undefined;
    };
    for (const word of words) {
      const chunk = reveal.reveal(String(word.at), word.text.length);
      if (run && run.chunk === chunk) run.text += word.text;
      else {
        flush();
        run = { chunk, text: word.text };
      }
    }
    flush();
  };
  const walk = (node: HastNode, inCode: boolean) => {
    if (!node.children) return;
    const out: HastNode[] = [];
    for (const child of node.children) {
      if (
        child.type === "text" &&
        !inCode &&
        typeof child.value === "string" &&
        /\S/.test(child.value) &&
        child.position?.start?.offset !== undefined &&
        child.position?.end?.offset !== undefined
      ) {
        wrap(child, out);
        continue;
      }
      if (child.type === "element")
        walk(
          child,
          inCode ||
            child.tagName === "pre" ||
            child.tagName === "code" ||
            // KaTeX output is laid out glyph by glyph.
            ((child.properties?.className as string[] | undefined) ?? []).some(
              (name) => name.startsWith("katex"),
            ),
        );
      out.push(child);
    }
    node.children = out;
  };
  return (tree: HastNode) => walk(tree, false);
}
