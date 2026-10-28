import type { PlanComment } from "../../shared/plan-comments";

interface TextNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: TextNode[];
}

/** Flat text excludes code blocks and table whitespace. */
export function planAnnotationPlugin(comments: readonly PlanComment[]) {
  return () => (tree: TextNode) => {
    const nodes: { node: TextNode; parent: TextNode; offset: number }[] = [];
    let text = "";
    function walk(parent: TextNode) {
      if (parent.tagName === "pre") return;
      for (const node of parent.children ?? []) {
        if (node.type === "text" && node.value !== undefined) {
          if (
            ["table", "thead", "tbody", "tfoot", "tr"].includes(
              parent.tagName ?? "",
            ) &&
            /^\s*$/.test(node.value)
          )
            continue;
          nodes.push({ node, parent, offset: text.length });
          text += node.value;
        } else walk(node);
      }
    }
    walk(tree);
    const ranges = comments.flatMap((entry) => {
      let start = entry.startOffset;
      let end = entry.endOffset;
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
      if (normalize(text.slice(start, end)) !== normalize(entry.selectedText)) {
        let nearest = -1;
        for (
          let index = text.indexOf(entry.selectedText);
          index !== -1;
          index = text.indexOf(entry.selectedText, index + 1)
        )
          if (
            nearest === -1 ||
            Math.abs(index - start) < Math.abs(nearest - start)
          )
            nearest = index;
        if (nearest === -1) return [];
        start = nearest;
        end = start + entry.selectedText.length;
      }
      return [{ id: entry.id, start, end }];
    });
    for (const { node, parent, offset } of nodes.reverse()) {
      const value = node.value!;
      const matches = ranges
        .filter(
          (range) => range.start < offset + value.length && range.end > offset,
        )
        .sort((left, right) => left.start - right.start);
      const children: TextNode[] = [];
      let cursor = 0;
      for (const range of matches) {
        const start = Math.max(0, range.start - offset);
        const end = Math.min(value.length, range.end - offset);
        if (start < cursor || end <= start) continue;
        if (start > cursor)
          children.push({ type: "text", value: value.slice(cursor, start) });
        children.push({
          type: "element",
          tagName: "mark",
          properties: { "data-plan-comment-id": range.id },
          children: [{ type: "text", value: value.slice(start, end) }],
        });
        cursor = end;
      }
      if (!cursor) continue;
      if (cursor < value.length)
        children.push({ type: "text", value: value.slice(cursor) });
      parent.children!.splice(parent.children!.indexOf(node), 1, ...children);
    }
  };
}

export function planTextNodes(root: HTMLElement) {
  const walker = root.ownerDocument.createTreeWalker(root, 4, {
    acceptNode(node) {
      const parent = node.parentElement;
      return parent?.closest("pre, [data-plan-comment-skip]") ||
        (["TABLE", "THEAD", "TBODY", "TFOOT", "TR"].includes(
          parent?.tagName ?? "",
        ) &&
          /^\s*$/.test(node.textContent ?? ""))
        ? 2
        : 1;
    },
  });
  const nodes: { node: Text; offset: number }[] = [];
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, offset });
    offset += node.textContent?.length ?? 0;
  }
  return nodes;
}

export function selectedPlanText(root: HTMLElement, range: Range) {
  const nodes = planTextNodes(root);
  function offset(container: Node, at: number) {
    const found = nodes.find((entry) => entry.node === container);
    if (found) return found.offset + at;
    const point = root.ownerDocument.createRange();
    point.setEnd(container, at);
    point.collapse(false);
    return (
      nodes.find((entry) => point.comparePoint(entry.node, 0) >= 0)?.offset ??
      nodes.reduce((total, entry) => total + entry.node.length, 0)
    );
  }
  const startOffset = offset(range.startContainer, range.startOffset);
  const endOffset = offset(range.endContainer, range.endOffset);
  const selectedText = nodes
    .map(({ node, offset }) =>
      node.data.slice(
        Math.max(0, startOffset - offset),
        Math.max(0, Math.min(node.length, endOffset - offset)),
      ),
    )
    .join("");
  return { startOffset, endOffset, selectedText };
}
