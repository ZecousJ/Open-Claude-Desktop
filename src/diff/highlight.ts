import type { createLowlight } from "lowlight";

/** lowlight, loaded with the view (ui/lazy-highlight.ts); without it lines are plain. */
type Lowlight = ReturnType<typeof createLowlight>;

export interface Segment {
  text: string;
  /** highlight.js classes, e.g. "hljs-keyword". */
  className?: string;
  /** Part of a word-level change. */
  changed?: boolean;
}

type Node = {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: Node[];
};

function flatten(node: Node, classes: string[], out: Segment[]) {
  if (node.type === "text") {
    if (node.value)
      out.push({
        text: node.value,
        className: classes.length ? classes.join(" ") : undefined,
      });
    return;
  }
  const own = node.properties?.className ?? [];
  for (const child of node.children ?? [])
    flatten(child, own.length ? [...classes, ...own] : classes, out);
}

/** Syntax-highlighted segments for one line, split where `changed` ranges begin and end. */
export function lineSegments(
  text: string,
  language?: string,
  changed: [number, number][] = [],
  lowlight?: Lowlight,
): Segment[] {
  let segments: Segment[] = [{ text }];
  if (language && lowlight?.registered(language) && text.length < 2_000) {
    try {
      const out: Segment[] = [];
      flatten(lowlight.highlight(language, text) as Node, [], out);
      segments = out;
    } catch {
      segments = [{ text }];
    }
  }
  if (!changed.length) return segments;
  const result: Segment[] = [];
  let offset = 0;
  for (const segment of segments) {
    const end = offset + segment.text.length;
    let cursor = offset;
    const cuts = [
      ...new Set(
        changed
          .flat()
          .filter((point) => point > offset && point < end)
          .sort((a, b) => a - b),
      ),
      end,
    ];
    for (const cut of cuts) {
      const inside = changed.some(
        ([from, to]) => cursor >= from && cursor < to,
      );
      result.push({
        ...segment,
        text: segment.text.slice(cursor - offset, cut - offset),
        ...(inside ? { changed: true } : {}),
      });
      cursor = cut;
    }
    offset = end;
  }
  return result.filter((segment) => segment.text);
}
