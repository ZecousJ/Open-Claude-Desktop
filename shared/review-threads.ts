/**
 * Review comments' text in the Changes panel's threads: plain text and
 * ```suggestion blocks, the reviewed lines a suggestion replaces (from the
 * comment's diff hunk), and the folded row's one-line summary.
 */

export type CommentSegment =
  { kind: "text"; text: string } | { kind: "suggestion"; code: string };

const fence = /^```suggestion[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

export function commentSegments(body: string): CommentSegment[] {
  const text = body.replace(/\r\n/g, "\n");
  const out: CommentSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(fence)) {
    const before = text.slice(last, match.index).trim();
    if (before) out.push({ kind: "text", text: before });
    out.push({ kind: "suggestion", code: match[1].replace(/\n$/, "") });
    last = match.index! + match[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push({ kind: "text", text: rest });
  return out;
}

/** Bidirectional controls, zero-width and other format characters. */
export const hasHiddenCharacters = (text: string) =>
  /[\p{Cf}\u2028\u2029]/u.test(text);

/**
 * The lines the comment was written against: the last `count` lines of its
 * diff hunk on the new side.
 */
export function reviewedText(diffHunk: string | undefined, count: number) {
  if (!diffHunk || count < 1) return undefined;
  const lines = diffHunk
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(1)
    .filter((line) => !line.startsWith("-") && !line.startsWith("\\"))
    .map((line) => line.slice(1));
  if (lines.length < count) return undefined;
  return lines.slice(-count).join("\n");
}

const plain = (line: string) =>
  line
    .slice(0, 200)
    .replace(/^>\s*|^#{1,6}\s+|^[-*+]\s+|^\d+\.\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, "$1$2")
    .trim();

/** The folded row's summary: the first plain line, else "Suggested change". */
export function commentSummary(segments: CommentSegment[]): string | undefined {
  let quoted: string | undefined;
  for (const segment of segments) {
    if (segment.kind !== "text") continue;
    for (const raw of segment.text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith(">") || /^<[a-zA-Z!/]/.test(line)) {
        quoted ||= plain(line);
        continue;
      }
      return plain(line);
    }
  }
  return segments.some((segment) => segment.kind === "suggestion")
    ? "Suggested change"
    : quoted;
}
