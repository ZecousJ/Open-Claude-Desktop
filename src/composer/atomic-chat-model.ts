import { Schema, type Node as ProseNode } from "prosemirror-model";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { validSkillTokens, type SkillToken } from "./skill-tokens";

/** O16 shared9 Cq: an inline, selectable atom with no editable children.
 * Only the current enabled, unambiguous inventory may create one on paste. */
export function chatSchema(callable: () => ReadonlySet<string>) {
  return new Schema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: {
        content: "inline*",
        group: "block",
        parseDOM: [{ tag: "p" }],
        toDOM: () => ["p", 0],
      },
      text: { group: "inline" },
      hard_break: {
        inline: true,
        group: "inline",
        selectable: false,
        parseDOM: [{ tag: "br" }],
        toDOM: () => ["br"],
      },
      skill: {
        inline: true,
        group: "inline",
        atom: true,
        selectable: true,
        attrs: { name: {} },
        parseDOM: [
          {
            tag: "span[data-claudex-skill]",
            getAttrs(element) {
              const name = element.getAttribute("data-claudex-skill") ?? "";
              return callable().has(name) ? { name } : false;
            },
          },
        ],
        // Clipboard HTML carries only the real command, never a path or a
        // trusted description from another account/document.
        toDOM: (node) => [
          "span",
          { "data-claudex-skill": node.attrs.name },
          `$${node.attrs.name}`,
        ],
        leafText: (node) => `$${node.attrs.name}`,
      },
    },
  });
}

export function chatDoc(
  schema: Schema,
  text: string,
  input: readonly SkillToken[],
) {
  // Existing draft references retain their identity/history while inventory
  // loads. The node view exposes a slash/card only for a live callable item;
  // unrecognized references remain honest raw command text.
  const tokens = validSkillTokens(text, input);
  let offset = 0;
  const paragraphs = text.split("\n").map((line) => {
    const nodes: ProseNode[] = [];
    let at = offset;
    for (const token of tokens) {
      if (token.start < offset || token.end > offset + line.length) continue;
      if (token.start > at)
        nodes.push(schema.text(text.slice(at, token.start)));
      nodes.push(schema.nodes.skill.create({ name: token.name }));
      at = token.end;
    }
    if (at < offset + line.length)
      nodes.push(schema.text(text.slice(at, offset + line.length)));
    offset += line.length + 1;
    return schema.nodes.paragraph.create(null, nodes);
  });
  return schema.nodes.doc.create(null, paragraphs);
}

interface Segment {
  from: number;
  to: number;
  start: number;
  end: number;
  atom: boolean;
}
function indexed(doc: ProseNode) {
  let text = "";
  const skillTokens: SkillToken[] = [],
    segments: Segment[] = [];
  doc.forEach((paragraph, position, index) => {
    if (index) {
      segments.push({
        from: position - 1,
        to: position + 1,
        start: text.length,
        end: text.length + 1,
        atom: true,
      });
      text += "\n";
    }
    paragraph.forEach((node, offset) => {
      const raw =
        node.type.name === "skill"
          ? `$${node.attrs.name}`
          : node.type.name === "hard_break"
            ? "\n"
            : (node.text ?? "");
      const start = text.length,
        from = position + 1 + offset;
      text += raw;
      segments.push({
        from,
        to: from + node.nodeSize,
        start,
        end: text.length,
        atom: !node.isText,
      });
      if (node.type.name === "skill")
        skillTokens.push({ name: node.attrs.name, start, end: text.length });
    });
  });
  return { text, skillTokens, segments };
}
export function chatDraft(doc: ProseNode) {
  const { text, skillTokens } = indexed(doc);
  return { text, skillTokens: validSkillTokens(text, skillTokens) };
}
export function rawToPosition(doc: ProseNode, value: number, bias: -1 | 1 = 1) {
  const { text, segments } = indexed(doc);
  const at = Math.max(0, Math.min(text.length, value));
  for (const segment of segments) {
    if (at > segment.end) continue;
    if (at <= segment.start) return segment.from;
    if (at === segment.end) return segment.to;
    return segment.atom
      ? bias < 0
        ? segment.from
        : segment.to
      : segment.from + at - segment.start;
  }
  return Math.max(1, doc.content.size - 1);
}
export function positionToRaw(
  doc: ProseNode,
  position: number,
  bias: -1 | 1 = 1,
) {
  const { text, segments } = indexed(doc);
  for (const segment of segments) {
    if (position > segment.to) continue;
    if (position <= segment.from) return segment.start;
    if (position === segment.to) return segment.end;
    return segment.atom
      ? bias < 0
        ? segment.start
        : segment.end
      : segment.start + position - segment.from;
  }
  return text.length;
}
export function rawSelection(
  doc: ProseNode,
  start: number,
  end = start,
  direction = "none",
) {
  const from = rawToPosition(doc, start, -1),
    to = rawToPosition(doc, end, 1);
  if (
    start !== end &&
    doc.nodeAt(from)?.type.name === "skill" &&
    to === from + 1
  )
    return NodeSelection.create(doc, from);
  return TextSelection.create(
    doc,
    direction === "backward" ? to : from,
    direction === "backward" ? from : to,
  );
}
