/**
 * Inline citations of a reply (R5, design R45 §4.6): where the reply cites a
 * page, a small chip names the site and a card shows the page on hover.
 *
 * The gateway records a finished message's citations as UTF-16 spans of its
 * text (`Item.citations`, from OpenAI's `url_citation` annotations). xAI
 * writes them into the text itself as `[[1]](https://…)` links. Both become
 * markers in the text before it is parsed as Markdown: a private-use
 * sentinel `<n>` naming citation group n. The Markdown renderer
 * (src/ui/Markdown.tsx, `citations` prop) turns each marker into a chip and
 * drops markers inside code, math, link addresses and raw HTML, so a marker
 * never changes a reply's block structure. Everything here is pure.
 *
 * Titles, snippets and URLs come from web pages and the model: they are only
 * ever rendered as text, and a site is named by the host the URL really
 * points at (so `https://evil.example@good.example` is not shown as either).
 */
import type { Item, Turn } from "../../shared/types";
import type { Citation, WebSource } from "../../shared/research";
import { cleanCitations, cleanWebSource } from "../../shared/gateway-signals";
import { sourceKey } from "../../shared/research";

/** Opens a citation marker; the group number and `markerClose` follow. */
export const markerOpen = "";
export const markerClose = "";
/** A marker in text: group number in capture 1. */
export const markerPattern = /(\d{1,4})/g;
const markerChars = /[]/g;

/** One cited page, with what the transcript knows about it. */
export interface CitedSource {
  url: string;
  /** The host the URL points at, without a leading `www.`. */
  host: string;
  title?: string;
  snippet?: string;
}

/** The pages cited at one place in a reply (one chip). */
export interface CitationGroup {
  sources: CitedSource[];
}

/** A reply's text with citation markers, and the groups they name. */
export interface CitationRender {
  text: string;
  groups: CitationGroup[];
}

/** The host a web address points at (lowercase, no `www.`), if it is http(s). */
export function sourceHost(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    return parsed.hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

// Second-level labels under a country code that are not the site's name
// (bbc.co.uk → bbc, abc.net.au → abc).
const genericSecondLevel = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "gov",
  "govt",
  "net",
  "nic",
  "or",
  "org",
  "ne",
  "go",
  "gob",
  "mil",
]);

/**
 * A site's short name for a chip: the host without `www.` and its public
 * suffix ("en.wikipedia.org" → "wikipedia", "bbc.co.uk" → "bbc"). An address
 * host (IPv4/IPv6) or a single label is shown whole.
 */
export function siteName(host: string): string {
  if (!host) return host;
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("["))
    return host;
  const labels = host
    .replace(/^www\./, "")
    .split(".")
    .filter(Boolean);
  if (labels.length < 2) return labels[0] ?? host;
  labels.pop();
  const tld = host.split(".").at(-1) ?? "";
  if (
    labels.length >= 2 &&
    tld.length === 2 &&
    genericSecondLevel.has(labels.at(-1)!)
  )
    labels.pop();
  return labels.at(-1) ?? host;
}

/**
 * A chip's label: the first page's title, else its site's name, and how many
 * other pages the chip holds.
 */
export function chipLabel(group: CitationGroup) {
  const first = group.sources[0];
  const name = first ? first.title?.trim() || siteName(first.host) : "";
  return group.sources.length > 1
    ? `${name} +${group.sources.length - 1}`
    : name;
}

/** The pages a turn's searches returned, by address (first seen wins). */
export function turnSources(turn: Pick<Turn, "items"> | undefined) {
  const byUrl = new Map<string, WebSource>();
  for (const item of turn?.items ?? []) {
    if (item.type !== "webSearch" || !Array.isArray(item.sources)) continue;
    for (const value of item.sources) {
      const source = cleanWebSource(value);
      const key = source && sourceKey(source.url);
      if (source && key && !byUrl.has(key)) byUrl.set(key, source);
    }
  }
  return byUrl;
}

/** Fenced code blocks of a text, as [start, end) UTF-16 ranges. */
export function fencedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let open: { fence: string; start: number } | undefined;
  let at = 0;
  for (const line of text.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (!open) open = { fence: fence[1], start: at };
      else if (
        fence[1][0] === open.fence[0] &&
        fence[1].length >= open.fence.length &&
        !fence[2].trim()
      ) {
        ranges.push([open.start, at + line.length]);
        open = undefined;
      }
    }
    at += line.length + 1;
  }
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

// A cited span that is only a link to the page, the way OpenAI writes a
// citation into the text: "([example.com](https://example.com/…))". The
// chip replaces it rather than repeating it.
const linkOnlySpan =
  /^\s*\(?\s*\[[^[\]\n]*\]\(\s*<?(https?:\/\/[^\s()<>]+)>?\s*\)\s*\)?\s*$/;
// xAI's inline citation: "[[1]](https://…)".
const xaiCitation = /\[\[(\d{1,3})\]\]\((https?:\/\/[^\s()]+)\)/g;

interface Edit {
  /** Replaced span; start === end inserts. */
  start: number;
  end: number;
  url: string;
  title?: string;
}

/** Citations the text itself carries as xAI `[[n]](url)` links. */
export function xaiInlineCitations(text: string): Citation[] {
  const found: Citation[] = [];
  for (const match of text.matchAll(xaiCitation)) {
    const start = match.index ?? 0;
    found.push({ url: match[2], start, end: start + match[0].length });
  }
  return cleanCitations(found, text.length);
}

function editsFor(text: string, citations: Citation[], inline: boolean) {
  const edits: Edit[] = [];
  for (const citation of citations) {
    const span = text.slice(citation.start, citation.end);
    const link = inline ? undefined : linkOnlySpan.exec(span);
    const replace =
      inline ||
      (link !== null &&
        link !== undefined &&
        sourceHost(link[1]) === sourceHost(citation.url));
    edits.push({
      start: replace ? citation.start : citation.end,
      end: citation.end,
      url: citation.url,
      title: citation.title,
    });
  }
  return edits;
}

// Where a chip may sit: a cited span that ends inside a word moves on to the
// end of the word; in a paragraph of full-width text (no spaces to stop at) to
// the end of the sentence.
const sentenceMark = /[。、！？，．；：｡､]/u;
const closingMark = /[\p{Pe}\p{Pf}]/u;
const trailingMark = /(?!\*)[\p{Pe}\p{Pf}\p{Po}\p{M}]/u;
const markupStart = /[`[<$"']|:\/\/|www\./i;
// A full-width comma, point or colon between digits ("1，000", "3．5") is part of
// a number, not the end of a clause; so is one between a Latin letter and a
// digit ("A：1").
const digit = /\p{N}/u;
const numberMark = /[，．：、､]/u;
const tightMark = /[，．：]/u;
const latinOrSpace = /^(?:[A-Za-zＡ-Ｚａ-ｚ]|\s)?$/u;
const delimiterRow = /^[ \t\r|:]*-[ \t\r|:-]*$/;
/** A space inside a table row: space, tab or a stray carriage return. */
const rowSpace = (char: string | undefined) =>
  char === " " || char === "\t" || char === "\r";

/** Whether the line holding `at` is a table row (it starts with a pipe). */
function inTableRow(text: string, at: number) {
  let first = text.lastIndexOf("\n", at - 1) + 1;
  while (text[first] === " " || text[first] === "\t") first++;
  return text[first] === "|";
}

/** Whether a chip placed before `at` would not cut a word, a sentence or a table cell. */
function endsPlace(text: string, at: number, sentences: boolean) {
  const char = text[at];
  if (/\s/.test(char)) return true;
  if (char === "|") {
    // Only a table's own pipe ends a cell: not an escaped one, one in
    // running text, or one right after a code fence's backticks.
    let slashes = 0;
    while (text[at - 1 - slashes] === "\\") slashes++;
    return (
      slashes % 2 === 0 &&
      inTableRow(text, at) &&
      text.slice(Math.max(0, at - 3), at) !== "```"
    );
  }
  if (!sentences || trailingMark.test(char)) return false;
  let back = at - 1;
  while (back > 0 && closingMark.test(text[back])) back--;
  const mark = text[back];
  const before = text[back - 1] ?? "";
  if (
    digit.test(char) &&
    numberMark.test(mark) &&
    (digit.test(before) || (tightMark.test(mark) && latinOrSpace.test(before)))
  )
    return false;
  return sentenceMark.test(mark);
}

/**
 * Where the cell closed by the table pipe at `pipe` ends: after its last
 * character, before the spaces in front of the pipe. -1 when `pipe` closes
 * no cell (not a pipe, the row's first, escaped, after a code fence's
 * backticks, or, with `skipDelimiter`, in the row under the header).
 */
function cellEnd(text: string, pipe: number, skipDelimiter: boolean) {
  if (pipe < 0 || pipe >= text.length || text[pipe] !== "|") return -1;
  const rowStart = text.lastIndexOf("\n", pipe - 1) + 1;
  const newline = text.indexOf("\n", pipe);
  const rowEnd = newline < 0 ? text.length : newline;
  let first = rowStart;
  while (text[first] === " " || text[first] === "\t") first++;
  if (first >= pipe || text[first] !== "|") return -1;
  if (skipDelimiter && delimiterRow.test(text.slice(rowStart, rowEnd)))
    return -1;
  let slashes = 0;
  while (text[pipe - 1 - slashes] === "\\") slashes++;
  let end = pipe;
  while (text[end - 1] === " " || text[end - 1] === "\t") end--;
  if (slashes % 2 === 1 || (end >= 3 && text.slice(end - 3, end) === "```"))
    return -1;
  return end;
}

/**
 * A chip that lands on a table cell's edge (at the start of a cell, in the
 * spaces before its closing pipe, or at the start of the line after a row)
 * belongs to the cell before it, so it moves back to the end of that cell's
 * text. Anywhere else `at` is kept.
 */
function tableCellPlace(text: string, at: number) {
  const before = text[at - 1];
  const after = text[at];
  const near =
    before === "|" ||
    after === "|" ||
    ((rowSpace(before) || before === "\n") &&
      at > 1 &&
      (text[at - 2] === "|" || rowSpace(text[at - 2]))) ||
    (rowSpace(after) &&
      at + 1 < text.length &&
      (text[at + 1] === "|" || rowSpace(text[at + 1])));
  if (!near) return at;
  const lineStart = before === "\n";
  const from = lineStart ? at - 1 : at;
  let runStart = from;
  while (rowSpace(text[runStart - 1])) runStart--;
  let runEnd = from;
  while (rowSpace(text[runEnd])) runEnd++;
  const previous = cellEnd(text, runStart - 1, lineStart);
  if (previous >= 0) return previous;
  if (lineStart || runStart === from) return at;
  const next = cellEnd(text, runEnd, false);
  return next >= 0 && next < from ? next : at;
}

/**
 * Moves each chip that follows its span to the end of the word (or sentence)
 * the span stopped in, so a chip never lands inside a word, a link or a table
 * cell. A chip already at a space or the end of the text stays; one that
 * would reach the next chip's place shares it. Replacing edits are not moved.
 */
function settleInsertions(text: string, edits: Edit[]) {
  const tables = text.includes("|");
  const order = edits
    .map((edit, index) => {
      if (!tables || edit.start !== edit.end) return { edit, index };
      const at = tableCellPlace(text, edit.end);
      return { edit: { ...edit, start: at, end: at }, index };
    })
    .filter(({ edit }) => edit.start === edit.end)
    .sort((a, b) => a.edit.end - b.edit.end);
  const settled = edits.slice();
  const blocks = new Map<number, boolean>();
  let nextAt = text.length;
  let nextPlace = text.length;
  for (let i = order.length - 1; i >= 0; i--) {
    const { edit, index } = order[i];
    const at = edit.end;
    const hasNext = i < order.length - 1;
    let place = at;
    if (hasNext && nextAt === at) place = nextPlace;
    else if (
      at > 0 &&
      at < text.length &&
      !/\s/.test(text[at - 1]) &&
      !/\s/.test(text[at])
    ) {
      const from = text.lastIndexOf("\n\n", at) + 1;
      let sentences = blocks.get(from);
      if (sentences === undefined) {
        const to = text.indexOf("\n\n", at);
        const block = text.slice(from, to < 0 ? undefined : to);
        sentences = sentenceMark.test(block) && !markupStart.test(block);
        blocks.set(from, sentences);
      }
      const limit = hasNext ? nextAt : text.length;
      while (place < limit && !endsPlace(text, place, sentences)) place++;
      if (hasNext && place === limit) place = nextPlace;
    }
    settled[index] = { ...edit, start: place, end: place };
    nextAt = at;
    nextPlace = place;
  }
  return settled;
}

/**
 * The reply's text with a marker where each group of citations goes, or
 * undefined when the reply cites nothing (it then renders as before).
 *
 * Citations come from `item.citations` when the gateway recorded any, else
 * from xAI links in the text. A span that is only a link to the cited page
 * is replaced by the chip; otherwise the chip follows the cited span.
 * Citations at the same place (or separated only by spaces) share one chip.
 * Spans in fenced code, out of range or overlapping an earlier one are
 * moved to its end or dropped. Private-use marker characters already in the
 * text are removed so a reply cannot forge a chip.
 */
export function citationRender(
  item: Pick<Item, "text" | "citations">,
  known: Map<string, WebSource> = new Map(),
): CitationRender | undefined {
  const text = typeof item.text === "string" ? item.text : "";
  if (!text) return;
  const recorded = cleanCitations(item.citations, text.length);
  const inline = !recorded.length;
  const citations = inline ? xaiInlineCitations(text) : recorded;
  if (!citations.length) return;
  const fences = fencedRanges(text);
  const inFence = (at: number) =>
    fences.some(([start, end]) => at > start && at < end);
  const edits = settleInsertions(text, editsFor(text, citations, inline))
    .filter((edit) => !inFence(edit.start) && !inFence(edit.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  // Place edits in order; overlapping ones become insertions after the last.
  const placed: Edit[] = [];
  let reached = 0;
  for (const edit of edits) {
    if (edit.start < reached) {
      if (edit.end <= reached)
        placed.push({ ...edit, start: reached, end: reached });
      else placed.push({ ...edit, start: edit.end, end: edit.end });
    } else placed.push(edit);
    reached = Math.max(reached, placed.at(-1)!.end);
  }

  // Group edits whose places touch or are separated only by spaces.
  type Slot = { start: number; end: number; edits: Edit[] };
  const slots: Slot[] = [];
  for (const edit of placed) {
    const last = slots.at(-1);
    if (last && /^[ \t]*$/.test(text.slice(last.end, edit.start))) {
      last.end = Math.max(last.end, edit.end);
      last.edits.push(edit);
    } else slots.push({ start: edit.start, end: edit.end, edits: [edit] });
  }

  const groups: CitationGroup[] = [];
  let out = "";
  let at = 0;
  for (const slot of slots) {
    const seen = new Set<string>();
    const sources: CitedSource[] = [];
    for (const edit of slot.edits) {
      const key = sourceKey(edit.url);
      const host = sourceHost(edit.url);
      if (!key || !host || seen.has(key)) continue;
      seen.add(key);
      const page = known.get(key);
      const title = edit.title || page?.title;
      sources.push({
        url: edit.url,
        host,
        ...(title ? { title } : {}),
        ...(page?.snippet ? { snippet: page.snippet } : {}),
      });
    }
    if (!sources.length) continue;
    const before = text.slice(at, slot.start).replace(markerChars, "");
    // A chip that replaces a link sits right after the cited words, like
    // one that follows them (the chip keeps its own margin).
    out += slot.start < slot.end ? before.replace(/[ \t]+$/, "") : before;
    out += `${markerOpen}${groups.length}${markerClose}`;
    groups.push({ sources });
    at = slot.end;
  }
  if (!groups.length) return;
  out += text.slice(at).replace(markerChars, "");
  return { text: out, groups };
}

/** A text without its markers (for code, math and addresses). */
export const stripMarkers = (value: string) =>
  value.replace(markerPattern, "").replace(markerChars, "");

/** Closest a citation card comes to the window edge, and its gap to the chip. */
export const cardMargin = 8;
export const cardGap = 6;

/**
 * Where a citation card of `size` goes for a chip at `box`: below it,
 * left-aligned, kept inside the window; above it when there is no room below.
 */
export function cardPosition(
  box: { left: number; top: number; bottom: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
) {
  const left = Math.max(
    cardMargin,
    Math.min(box.left, view.width - size.width - cardMargin),
  );
  const below = box.bottom + cardGap;
  const fits = below + size.height <= view.height - cardMargin;
  const above = box.top - cardGap - size.height;
  const top = fits || above < cardMargin ? below : above;
  return { left, top };
}
