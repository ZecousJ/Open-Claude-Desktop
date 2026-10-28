/**
 * Turns citation markers (src/citations/citations.ts) into `claudex-cite`
 * elements while a reply's Markdown is parsed. A marker in running text
 * becomes a chip in place; one in a link's text or address becomes a chip
 * after the link (a chip is a button and cannot sit inside a link); markers
 * in code, math, raw HTML, image text and addresses are removed. Markers
 * naming a group that does not exist are removed too.
 */
import { markerPattern, stripMarkers } from "./citations";

export const citationTag = "claudex-cite";

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  children?: MdNode[];
  data?: Record<string, unknown>;
};

const literal = new Set(["code", "inlineCode", "math", "inlineMath", "html"]);

function chip(index: number): MdNode {
  return {
    type: "citation",
    children: [],
    data: {
      hName: citationTag,
      hProperties: { dataCitation: String(index) },
      hChildren: [],
    },
  };
}

/** Group numbers named by markers in a text, in order. */
function markersIn(value: string, count: number) {
  const found: number[] = [];
  for (const match of value.matchAll(markerPattern)) {
    const index = Number(match[1]);
    if (index < count) found.push(index);
  }
  return found;
}

/** Strips markers from a node's own fields and all its descendants; returns the groups found. */
function stripAll(node: MdNode, count: number): number[] {
  // The link's words first, then its address.
  const found: number[] = [];
  for (const child of node.children ?? [])
    found.push(...stripAll(child, count));
  for (const field of ["value", "url", "alt", "title"] as const) {
    const value = node[field];
    if (typeof value !== "string") continue;
    if (node.type === "text" || field !== "value")
      found.push(...markersIn(value, count));
    node[field] = stripMarkers(value);
  }
  return found;
}

function splitText(node: MdNode, count: number): MdNode[] {
  const value = node.value ?? "";
  const parts: MdNode[] = [];
  let at = 0;
  for (const match of value.matchAll(markerPattern)) {
    const start = match.index ?? 0;
    if (start > at) parts.push({ type: "text", value: value.slice(at, start) });
    const index = Number(match[1]);
    if (index < count) parts.push(chip(index));
    at = start + match[0].length;
  }
  if (!parts.length) return [{ ...node, value: stripMarkers(value) }];
  if (at < value.length) parts.push({ type: "text", value: value.slice(at) });
  return parts.map((part) =>
    part.type === "text"
      ? { ...part, value: stripMarkers(part.value ?? "") }
      : part,
  );
}

function walk(parent: MdNode, count: number) {
  if (!parent.children) return;
  const next: MdNode[] = [];
  for (const child of parent.children) {
    if (child.type === "text") next.push(...splitText(child, count));
    else if (literal.has(child.type)) {
      stripAll(child, count);
      next.push(child);
    } else if (child.type === "link" || child.type === "linkReference") {
      const moved = stripAll(child, count);
      next.push(child, ...[...new Set(moved)].map(chip));
    } else if (
      child.type === "image" ||
      child.type === "imageReference" ||
      child.type === "definition"
    ) {
      stripAll(child, count);
      next.push(child);
    } else {
      walk(child, count);
      next.push(child);
    }
  }
  parent.children = next;
}

/** The remark plugin; `count` is how many citation groups the reply has. */
export function remarkCitations(options: { count: number }) {
  return (tree: MdNode) => walk(tree, options.count);
}
