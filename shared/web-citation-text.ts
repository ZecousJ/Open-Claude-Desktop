import { commonmarkLanguage } from "@codemirror/lang-markdown";

const markerStart = "\uE200";
const markerHeader = "\uE200cite";
const completeMarker = /\uE200cite(?:\uE202turn\d+[a-z]+\d+)+\uE201/g;
const partialReferences = /^(?:\uE202turn\d+[a-z]+\d+)*(?:\uE202[a-z0-9]*)?$/;
const codeNodes = new Set(["CodeBlock", "FencedCode", "InlineCode"]);

export function projectWebCitationText(text: string, appendOnly = false) {
  if (!text.includes(markerStart)) return { text, displayOffset: (offset: number) => offset };

  const ranges = Array.from(text.matchAll(completeMarker), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const tailStart = text.lastIndexOf(markerStart);
  const tail = text.slice(tailStart);
  const references = tail.slice(markerHeader.length);
  if (markerHeader.startsWith(tail) ||
      (tail.startsWith(markerHeader) && partialReferences.exec(references)?.[0] === references)) {
    ranges.push({ start: tailStart, end: text.length });
  }

  const markdown = commonmarkLanguage.parser.parse(text);
  const firstBacktick = appendOnly ? text.indexOf("`") : -1;
  const removed: typeof ranges = [];
  let display = "", cursor = 0;
  for (const range of ranges) {
    const { start, end } = range;
    // A later backtick can turn an unfinished paragraph into a code span.
    // Completion text must remain append-only while that decision is pending.
    if (firstBacktick !== -1 && firstBacktick < start) {
      display += text.slice(cursor, start);
      removed.push({ start, end: text.length });
      cursor = text.length;
      break;
    }
    let node = markdown.resolveInner(start, 1);
    while (node.parent && !codeNodes.has(node.name)) node = node.parent;
    if (codeNodes.has(node.name)) continue;
    display += text.slice(cursor, start);
    removed.push(range);
    cursor = end;
  }

  return {
    text: display + text.slice(cursor),
    displayOffset(offset: number) {
      let removedLength = 0;
      for (const { start, end } of removed) {
        if (offset <= start) break;
        removedLength += Math.min(offset, end) - start;
      }
      return offset - removedLength;
    },
  };
}
