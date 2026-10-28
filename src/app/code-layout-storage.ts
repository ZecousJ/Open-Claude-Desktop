import {
  stackId,
  leaf,
  cloneCodeNode,
  codeTileIds,
  codeTilePath,
  atPath,
  parentAt,
  finish,
} from "./code-pane-layout-model";
import type {
  CodeStack,
  CodeNode,
  CodeLayout,
  CodePlacement,
} from "./code-pane-layout-model";

export function restoreCodePlacement(
  layout: CodeLayout,
  id: string,
  hint: CodePlacement | undefined,
): CodeLayout | undefined {
  if (
    !hint ||
    !Array.isArray(hint.anchorIds) ||
    !["row", "column"].includes(hint.direction) ||
    ![0, 1].includes(hint.side) ||
    !Number.isFinite(hint.ratio) ||
    hint.ratio < 0.001 ||
    hint.ratio > 1000 ||
    codeTileIds(layout.root).includes(id)
  )
    return;
  const root = cloneCodeNode(layout.root) as CodeStack,
    anchors = new Set<string>();
  let path: number[] | undefined;
  for (const anchor of hint.anchorIds) {
    const found = codeTilePath(root, anchor);
    if (!found) continue;
    anchors.add(anchor);
    if (!path) path = found;
    else {
      let same = 0;
      while (
        same < path.length &&
        same < found.length &&
        path[same] === found[same]
      )
        same++;
      path = path.slice(0, same);
    }
  }
  if (!path) return;
  let node = atPath(root, path);
  if (!node) return;
  if (node.kind === "stack") {
    const membership = node.children.map((child) => {
        const ids = codeTileIds(child),
          count = ids.filter((id) => anchors.has(id)).length;
        return count === 0 ? "none" : count === ids.length ? "all" : "some";
      }),
      start = membership.indexOf("all"),
      end = membership.lastIndexOf("all");
    if (
      !membership.includes("some") &&
      membership.includes("none") &&
      start >= 0 &&
      membership.slice(start, end + 1).every((value) => value === "all")
    ) {
      const children = node.children.splice(start, end - start + 1),
        group: CodeStack = {
          kind: "stack",
          id: stackId(),
          direction: node.direction,
          flex: children.reduce((sum, child) => sum + child.flex, 0),
          children,
        };
      node.children.splice(start, 0, group);
      path = [...path, start];
      node = group;
    }
  }
  const parent = parentAt(root, path),
    destination =
      parent?.direction === hint.direction
        ? parent
        : node.kind === "stack" && node.direction === hint.direction
          ? node
          : undefined;
  if (destination) {
    const total = destination.children.reduce(
        (sum, child) => sum + child.flex,
        0,
      ),
      flex = hint.ratio * total;
    if (!Number.isFinite(flex) || flex <= 0) return;
    const index =
      destination === parent
        ? path.at(-1)! + hint.side
        : hint.side * destination.children.length;
    const other =
      destination === parent && hint.direction === "row"
        ? destination.children[hint.side ? index : index - 1]
        : undefined;
    if (
      other &&
      !hint.otherSideIds.some((id) => codeTileIds(other).includes(id))
    )
      return;
    destination.children.splice(index, 0, leaf(id, flex));
    return finish(root);
  }
  const next = leaf(id, hint.ratio),
    group: CodeStack = {
      kind: "stack",
      id: stackId(),
      direction: hint.direction,
      flex: node.flex,
      children: hint.side === 0 ? [next, node] : [node, next],
    };
  node.flex = 1;
  if (parent) parent.children[path.at(-1)!] = group;
  return finish(parent ? root : group);
}

/** Same safe flex fallback as the source loader, with bounded local JSON. */
export function loadCodeLayout(
  raw: unknown,
  known: readonly string[],
): CodeLayout | undefined {
  if (!raw || typeof raw !== "object") return;
  const input = (raw as { root?: unknown }).root,
    seen = new Set<string>(),
    stackIds = new Set<string>();
  let count = 0;
  const read = (value: unknown, depth: number): CodeNode | undefined => {
    if (!value || typeof value !== "object" || depth > 32 || ++count > 128)
      return;
    const item = value as Record<string, unknown>,
      flex =
        typeof item.flex === "number" &&
        Number.isFinite(item.flex) &&
        item.flex > 0
          ? item.flex
          : 1;
    if (typeof item.tileId === "string") {
      if (
        (item.tileId !== "chat" && !known.includes(item.tileId)) ||
        seen.has(item.tileId)
      )
        return;
      seen.add(item.tileId);
      return leaf(item.tileId, flex);
    }
    if (!Array.isArray(item.children)) return;
    const children = item.children
      .map((child) => read(child, depth + 1))
      .filter((child): child is CodeNode => !!child);
    if (!children.length) return;
    const id =
      typeof item.id === "string" &&
      item.id.length < 100 &&
      !stackIds.has(item.id)
        ? item.id
        : stackId();
    stackIds.add(id);
    return {
      kind: "stack",
      id,
      direction: item.direction === "column" ? "column" : "row",
      flex,
      children,
    };
  };
  const parsed = read(input, 0);
  if (!parsed) return;
  let result = finish(parsed);
  if (!seen.has("chat"))
    result = finish(
      result.root.direction === "row"
        ? {
            ...result.root,
            children: [...result.root.children, leaf("chat", 2)],
          }
        : {
            kind: "stack",
            id: stackId(),
            direction: "row",
            flex: 1,
            children: [result.root, leaf("chat", 2)],
          },
    );
  return result;
}
