/** Native Code tiling, adapted from the readable official model:
 * cf53e1812 (clone/path/normalize/drop/weights) and c03935b01:890-950,1606-1650
 * (edge targets and opening). No renderer state is stored in this tree. */
export type CodeAxis = "row" | "column";
export type CodeEdge = "left" | "right" | "top" | "bottom";
export type CodeLeaf = { kind: "tile"; tileId: string; flex: number };
export type CodeStack = {
  kind: "stack";
  id: string;
  direction: CodeAxis;
  flex: number;
  children: CodeNode[];
};
export type CodeNode = CodeLeaf | CodeStack;
export type CodeLayout = { root: CodeStack };
export type CodeDrop =
  | { kind: "insert"; stackId: string; index: number }
  | { kind: "split"; stackId: string; direction: CodeAxis; index: number }
  | { kind: "wrap"; tileId: string; direction: CodeAxis; index: number };
let nonce = 0;
const prefix =
  globalThis.crypto?.randomUUID?.().slice(0, 8) ??
  Math.random().toString(36).slice(2, 10);
export const stackId = () => `code-stack-${prefix}-${++nonce}`;
export const leaf = (tileId: string, flex = 1): CodeLeaf => ({
  kind: "tile",
  tileId,
  flex,
});
export const codePaneConfig = {
  gap: 12,
  padding: 8,
  border: 1,
  minWidth: 280,
  minHeight: 100,
  minBase: 100,
  dragLift: 24,
} as const;
export const cloneCodeNode = (node: CodeNode): CodeNode =>
  node.kind === "tile"
    ? { ...node }
    : { ...node, children: node.children.map(cloneCodeNode) };
export function codeTileIds(node: CodeNode): string[] {
  return node.kind === "tile"
    ? [node.tileId]
    : node.children.flatMap(codeTileIds);
}
export function codeTilePath(
  node: CodeNode,
  id: string,
  path: number[] = [],
): number[] | undefined {
  if (node.kind === "tile") return node.tileId === id ? path : undefined;
  for (let i = 0; i < node.children.length; i++) {
    const found = codeTilePath(node.children[i], id, [...path, i]);
    if (found) return found;
  }
}
export function atPath(
  root: CodeNode,
  path: readonly number[],
): CodeNode | undefined {
  let node = root;
  for (const index of path) {
    if (node.kind !== "stack") return;
    node = node.children[index];
    if (!node) return;
  }
  return node;
}
export function parentAt(
  root: CodeNode,
  path: readonly number[],
): CodeStack | undefined {
  if (!path.length) return;
  const node = atPath(root, path.slice(0, -1));
  return node?.kind === "stack" ? node : undefined;
}
export function findStack(node: CodeNode, id: string): CodeStack | undefined {
  if (node.kind !== "stack") return;
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findStack(child, id);
    if (found) return found;
  }
}
function stackParent(node: CodeNode, id: string): CodeStack | undefined {
  if (node.kind !== "stack") return;
  for (const child of node.children) {
    if (child.kind === "stack" && child.id === id) return node;
    const found = stackParent(child, id);
    if (found) return found;
  }
}
/** Official normalization collapses singletons and flattens adjacent equal axes. */
function normalize(node: CodeNode): CodeNode {
  if (node.kind === "tile") return node;
  const children = node.children
    .map(normalize)
    .filter((child) => child.kind === "tile" || child.children.length)
    .flatMap((child) =>
      child.kind === "stack" && child.direction === node.direction
        ? child.children
        : [child],
    );
  return children.length === 1
    ? { ...children[0], flex: node.flex }
    : { ...node, children };
}
export function finish(node: CodeNode): CodeLayout {
  const normalized = normalize(node);
  return {
    root:
      normalized.kind === "stack"
        ? normalized
        : {
            kind: "stack",
            id: stackId(),
            direction: "row",
            flex: 1,
            children: [normalized],
          },
  };
}
export function initialCodeLayout(): CodeLayout {
  return finish(leaf("chat", 2));
}
export function removeCodeTile(layout: CodeLayout, id: string): CodeLayout {
  if (id === "chat") return layout;
  const root = cloneCodeNode(layout.root),
    path = codeTilePath(root, id),
    parent = path && parentAt(root, path);
  if (!path || !parent) return layout;
  parent.children.splice(path.at(-1)!, 1);
  return finish(root);
}
export function applyCodeDrop(
  layout: CodeLayout,
  id: string,
  target: CodeDrop,
): CodeLayout {
  const root = cloneCodeNode(layout.root),
    path = codeTilePath(root, id),
    parent = path && parentAt(root, path);
  if (!path || !parent) return layout;
  const index = path.at(-1)!,
    moving = parent.children[index];
  if (target.kind === "insert" && parent.id === target.stackId) {
    const rest = parent.children.filter((_, i) => i !== index);
    rest.splice(Math.max(0, Math.min(target.index, rest.length)), 0, moving);
    parent.children = rest;
    return finish(root);
  }
  parent.children.splice(index, 1);
  if (target.kind === "wrap") {
    const destination = codeTilePath(root, target.tileId),
      owner = destination && parentAt(root, destination);
    if (!destination || !owner) return layout;
    const at = destination.at(-1)!,
      other = owner.children[at],
      next = leaf(id);
    owner.children[at] = {
      kind: "stack",
      id: stackId(),
      direction: target.direction,
      flex: other.flex,
      children: target.index === 0 ? [next, other] : [other, next],
    };
    other.flex = 1;
    return finish(root);
  }
  const destination = findStack(root, target.stackId);
  if (!destination) return layout;
  if (target.kind === "split" && target.direction !== destination.direction) {
    const next = leaf(id),
      wrapped: CodeStack = {
        kind: "stack",
        id: stackId(),
        direction: target.direction,
        flex: destination.flex,
        children:
          target.index === 0 ? [next, destination] : [destination, next],
      };
    destination.flex = 1;
    const owner = stackParent(root, destination.id);
    if (owner) {
      owner.children[
        owner.children.findIndex(
          (child) => child.kind === "stack" && child.id === destination.id,
        )
      ] = wrapped;
      return finish(root);
    }
    return finish(wrapped);
  }
  const at =
    target.kind === "split" &&
    destination.id === parent.id &&
    target.index > index
      ? target.index - 1
      : target.index;
  destination.children.splice(
    Math.max(0, Math.min(at, destination.children.length)),
    0,
    leaf(id, target.kind === "split" ? 1 : moving.flex),
  );
  return finish(root);
}
/** c03935b01/Qn: traverse alternating axes, preserving the current subtree edge. */
export function codeEdgeTarget(
  layout: CodeLayout,
  id: string,
  edge: CodeEdge,
): CodeDrop | "at-edge" | undefined {
  const root = layout.root,
    path = codeTilePath(root, id),
    parent = path && parentAt(root, path);
  if (!path || !parent) return;
  if (path.length === 1 && parent.children.length === 1) return "at-edge";
  const row = parent.direction === "row",
    start = edge === "left" || edge === "top";
  if (row === (edge === "left" || edge === "right")) {
    let target: CodeDrop | "at-edge" = "at-edge";
    for (let depth = path.length; depth >= 1; depth -= 2) {
      const owner = parentAt(root, path.slice(0, depth));
      if (!owner) break;
      const last = owner.children.length - 1;
      if (path[depth - 1] !== (start ? 0 : last))
        target = {
          kind: "insert",
          stackId: owner.id,
          index: start ? 0 : depth === path.length ? last : last + 1,
        };
    }
    return target;
  }
  let destination: CodeStack | undefined;
  for (let depth = path.length - 1; depth >= 1; depth -= 2) {
    const owner = parentAt(root, path.slice(0, depth));
    if (!owner) break;
    const atEdge = path[depth - 1] === (start ? 0 : owner.children.length - 1);
    if (!destination || !atEdge) destination = owner;
  }
  return destination
    ? {
        kind: "insert",
        stackId: destination.id,
        index: start ? 0 : destination.children.length,
      }
    : {
        kind: "split",
        stackId: parent.id,
        direction: row ? "column" : "row",
        index: start ? 0 : 1,
      };
}
export function moveCodeTileToEdge(
  layout: CodeLayout,
  id: string,
  edge: CodeEdge,
): CodeLayout {
  const target = codeEdgeTarget(layout, id, edge);
  if (!target || target === "at-edge") return layout;
  const oldPath = codeTilePath(layout.root, id),
    oldParent = oldPath && parentAt(layout.root, oldPath);
  const next = applyCodeDrop(layout, id, target);
  if (target.kind !== "insert" || target.stackId === oldParent?.id) return next;
  const root = cloneCodeNode(next.root),
    path = codeTilePath(root, id),
    parent = path && parentAt(root, path);
  if (path && parent)
    parent.children[path.at(-1)!] = {
      ...parent.children[path.at(-1)!],
      flex: 1,
    };
  return { root: root as CodeStack };
}
const wideTools = new Set([
  "files",
  "changes",
  "browser",
  "artifact",
  "pr",
  "widget",
]);
export function openCodeTile(
  layout: CodeLayout,
  id: string,
  lastFlex: Record<string, number> = {},
): CodeLayout {
  const ids = codeTileIds(layout.root);
  if (ids.includes(id)) return layout;
  if (ids.every((tile) => tile === "chat"))
    return finish({
      kind: "stack",
      id: stackId(),
      direction: "row",
      flex: 1,
      children: [
        leaf("chat", 2),
        leaf(id, lastFlex[id] ?? (wideTools.has(id) ? 3 : 1)),
      ],
    });
  const root = cloneCodeNode(layout.root) as CodeStack,
    last = root.direction === "row" ? root.children.at(-1)! : root;
  if (
    last.kind === "tile" &&
    last.tileId !== "chat" &&
    id !== "terminal" &&
    last.tileId !== "terminal"
  ) {
    const path = codeTilePath(root, last.tileId)!,
      parent = parentAt(root, path)!;
    parent.children[path.at(-1)!] = {
      kind: "stack",
      id: stackId(),
      direction: "column",
      flex: last.flex,
      children: [{ ...last, flex: 1 }, leaf(id)],
    };
    return finish(root);
  }
  return finish(
    root.direction === "row"
      ? { ...root, children: [...root.children, leaf(id)] }
      : {
          kind: "stack",
          id: stackId(),
          direction: "row",
          flex: 1,
          children: [{ ...root, flex: 1 }, leaf(id)],
        },
  );
}
export function reconcileCodeLayout(
  layout: CodeLayout,
  ids: readonly string[],
): CodeLayout {
  let next = layout;
  for (const id of codeTileIds(next.root))
    if (id !== "chat" && !ids.includes(id)) next = removeCodeTile(next, id);
  for (const id of ids) if (id !== "chat") next = openCodeTile(next, id);
  return next;
}

export type CodeRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export type CodeDivider = {
  stackId: string;
  index: number;
  direction: CodeAxis;
  rect: CodeRect;
  before: string[];
  after: string[];
  value: number;
  min: number;
  max: number;
  weights: number[];
  available: number;
};
export function codeNodeMinimum(node: CodeNode, axis: CodeAxis): number {
  const minimum =
    axis === "row" ? codePaneConfig.minWidth : codePaneConfig.minHeight;
  // The conversation keeps its 320px column by running on under the next card,
  // so across a row its tile may shrink to the base minimum.
  if (node.kind === "tile")
    return axis === "row" && node.tileId === "chat"
      ? codePaneConfig.minBase
      : minimum;
  const children = node.children.map((child) => codeNodeMinimum(child, axis));
  return node.direction === axis
    ? children.reduce((a, b) => a + b, 0) +
        codePaneConfig.gap * Math.max(0, children.length - 1)
    : Math.max(minimum, ...children);
}
/** cf53e1812/D: minimum-constrained flex weights with proportional fallback. */
export function resolvedCodeWeights(
  weights: readonly number[],
  minimums: readonly number[],
  available: number,
): number[] {
  const count = weights.length;
  if (!count || available <= 0) return [...weights];
  const total = weights.reduce((a, b) => a + b, 0) || count,
    fixed = new Set<number>();
  let sizes = weights.map((weight) => (weight / total) * available);
  for (;;) {
    const small = sizes.findIndex(
      (size, index) => !fixed.has(index) && size < minimums[index] - 0.5,
    );
    if (small < 0) break;
    fixed.add(small);
    const reserved = [...fixed].reduce(
        (sum, index) => sum + minimums[index],
        0,
      ),
      flex = weights.reduce(
        (sum, weight, index) => (fixed.has(index) ? sum : sum + weight),
        0,
      ),
      remaining = available - reserved;
    if (flex <= 0 || remaining <= 0) {
      const sum = minimums.reduce((a, b) => a + b, 0) || 1;
      sizes = minimums.map((min) => (min / sum) * available);
      break;
    }
    sizes = weights.map((weight, index) =>
      fixed.has(index) ? minimums[index] : (weight / flex) * remaining,
    );
  }
  const sum = sizes.reduce((a, b) => a + b, 0) || count;
  return sizes.map((size) => (size * count) / sum);
}
export function resolveCodeLayout(
  layout: CodeLayout,
  width: number,
  height: number,
) {
  const rects = new Map<string, CodeRect>(),
    dividers: CodeDivider[] = [],
    padding = codePaneConfig.padding + codePaneConfig.border;
  const walk = (node: CodeNode, box: CodeRect) => {
    rects.set(node.kind === "tile" ? node.tileId : node.id, box);
    if (node.kind === "tile") return;
    const row = node.direction === "row",
      available = Math.max(
        0,
        (row ? box.width : box.height) -
          codePaneConfig.gap * Math.max(0, node.children.length - 1),
      );
    const weights = resolvedCodeWeights(
        node.children.map((child) => child.flex),
        node.children.map((child) => codeNodeMinimum(child, node.direction)),
        available,
      ),
      sum = weights.reduce((a, b) => a + b, 0) || 1;
    let accumulated = 0,
      used = 0,
      cursor = 0;
    node.children.forEach((child, index) => {
      accumulated += weights[index];
      const end = Math.round((accumulated / sum) * available),
        size = end - used;
      used = end;
      const next = {
        left: box.left + (row ? cursor : 0),
        top: box.top + (row ? 0 : cursor),
        width: row ? size : box.width,
        height: row ? box.height : size,
      };
      walk(child, next);
      cursor += size;
      if (index < node.children.length - 1) {
        const pair = weights[index] + weights[index + 1],
          pairPx = (pair / sum) * available;
        const beforeMin = codeNodeMinimum(child, node.direction),
          afterMin = codeNodeMinimum(node.children[index + 1], node.direction);
        const value = Math.round((weights[index] / pair) * 100);
        const constrained = beforeMin + afterMin > pairPx;
        dividers.push({
          stackId: node.id,
          index,
          direction: node.direction,
          rect: {
            left: box.left + (row ? cursor : 0),
            top: box.top + (row ? 0 : cursor),
            width: row ? codePaneConfig.gap : box.width,
            height: row ? box.height : codePaneConfig.gap,
          },
          before: codeTileIds(child),
          after: codeTileIds(node.children[index + 1]),
          value,
          min: constrained
            ? value
            : Math.min(value, Math.round((beforeMin / pairPx) * 100)),
          max: constrained
            ? value
            : Math.max(value, Math.round(((pairPx - afterMin) / pairPx) * 100)),
          weights,
          available,
        });
        cursor += codePaneConfig.gap;
      }
    });
  };
  walk(layout.root, {
    left: padding,
    top: padding,
    width: Math.max(0, width - 2 * padding),
    height: Math.max(0, height - 2 * padding),
  });
  return { rects, dividers };
}
export function resizeCodeDivider(
  layout: CodeLayout,
  divider: CodeDivider,
  pixels: number,
): CodeLayout {
  const root = cloneCodeNode(layout.root) as CodeStack,
    stack = findStack(root, divider.stackId);
  if (!stack) return layout;
  const index = divider.index,
    before = stack.children[index],
    after = stack.children[index + 1];
  if (!before || !after || !divider.available) return layout;
  const weights = [...divider.weights],
    sum = weights.reduce((a, b) => a + b, 0),
    pair = weights[index] + weights[index + 1],
    minimumBefore =
      (codeNodeMinimum(before, stack.direction) / divider.available) * sum,
    minimumAfter =
      (codeNodeMinimum(after, stack.direction) / divider.available) * sum;
  if (minimumBefore + minimumAfter > pair) return layout;
  weights[index] = Math.max(
    minimumBefore,
    Math.min(
      pair - minimumAfter,
      weights[index] + (pixels / divider.available) * sum,
    ),
  );
  weights[index + 1] = pair - weights[index];
  stack.children = stack.children.map((child, i) => ({
    ...child,
    flex: weights[i],
  }));
  return { root };
}

export interface CodePlacement {
  anchorIds: string[];
  otherSideIds: string[];
  direction: CodeAxis;
  side: 0 | 1;
  ratio: number;
}
/** cf53e1812/G,q: restore a closed pane beside the surviving anchor group. */
export function captureCodePlacement(
  layout: CodeLayout,
  id: string,
): CodePlacement | undefined {
  const path = codeTilePath(layout.root, id),
    parent = path && parentAt(layout.root, path);
  if (!path || !parent || parent.children.length < 2) return;
  const index = path.at(-1)!,
    side = index > 0 ? 1 : 0,
    anchor = parent.children[side ? index - 1 : index + 1],
    other = side ? parent.children[index + 1] : undefined,
    flex = parent.children[index].flex,
    rest = parent.children.reduce(
      (sum, child, i) => (i === index ? sum : sum + child.flex),
      0,
    );
  return {
    anchorIds: codeTileIds(anchor),
    otherSideIds: other ? codeTileIds(other) : [],
    direction: parent.direction,
    side,
    ratio: flex > 0 && rest > 0 ? flex / rest : 1,
  };
}
