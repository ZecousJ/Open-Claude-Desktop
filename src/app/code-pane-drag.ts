/** Drop strips and duplicate-topology filtering from cf53e1812/w,M.
 * Regions use the same 24px edge strips, 16px drag threshold and source
 * parent grouping. Geometry comes from the renderer, never from editor state. */
import {
  applyCodeDrop,
  codeTileIds,
  codeTilePath,
  findStack,
  type CodeAxis,
  type CodeDrop,
  type CodeLayout,
  type CodeNode,
  type CodeRect,
  type CodeStack,
} from "./code-pane-layout-model";
type Point = { x: number; y: number };
type Rect = CodeRect & { right: number; bottom: number };
type DropRegion =
  | { kind: "target"; rect: Rect; target: CodeDrop; ownStrip?: boolean }
  | { kind: "rearrange"; rect: Rect; stackId: string; direction: CodeAxis };
export type CodeDragSnapshot = {
  rects: Map<string, Rect>;
  regions: DropRegion[];
  parent: CodeStack;
  start: Point;
  id: string;
};
const rect = (
  left: number,
  top: number,
  width: number,
  height: number,
): Rect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});
const inside = (p: Point, r: Rect) =>
  p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
const nodeKey = (node: CodeNode) =>
  node.kind === "tile" ? node.tileId : node.id;
const topology = (layout: CodeLayout) => {
  const walk = (node: CodeNode): string =>
    node.kind === "tile"
      ? `T:${node.tileId}`
      : `S[${node.direction}](${node.children.map(walk).join(",")})`;
  return walk(layout.root);
};
const strips = (r: Rect, axis: CodeAxis, wide = false) => {
  if (axis === "row") {
    const width = wide ? Math.max(24, Math.floor(r.width / 3)) : 24;
    return [
      rect(r.left, r.top, width, r.height),
      rect(r.right - width, r.top, width, r.height),
    ];
  }
  const height = wide ? Math.max(24, Math.floor(r.height / 3)) : 24;
  return [
    rect(r.left, r.top, r.width, 24),
    rect(r.left, r.bottom - height, r.width, height),
  ];
};
export function codeDragSnapshot(
  layout: CodeLayout,
  boxes: Map<string, CodeRect>,
  id: string,
  start: Point,
): CodeDragSnapshot | undefined {
  const path = codeTilePath(layout.root, id);
  if (!path?.length) return;
  let parent = layout.root;
  for (const index of path.slice(0, -1)) {
    const node = parent.children[index];
    if (node.kind !== "stack") return;
    parent = node;
  }
  const rects = new Map(
    [...boxes].map(([key, box]) => [
      key,
      rect(box.left, box.top, box.width, box.height),
    ]),
  );
  const root = layout.root,
    outer = rects.get(root.id);
  if (!outer || !rects.has(id)) return;
  const regions: DropRegion[] = [];
  const edgeRect = (edge: string, size: number) =>
    edge === "top"
      ? rect(outer.left, outer.top - 10000, outer.width, size + 10000)
      : edge === "bottom"
        ? rect(outer.left, outer.bottom - size, outer.width, size + 10000)
        : rect(
            edge === "left" ? outer.left - 10000 : outer.right - size,
            outer.top - 10000,
            size + 10000,
            outer.height + 20000,
          );
  for (const [edge, index, axis] of [
    ["top", 0, "column"],
    ["bottom", root.direction === "row" ? 1 : root.children.length, "column"],
    ["left", 0, "row"],
    ["right", root.direction === "row" ? root.children.length : 1, "row"],
  ] as const)
    regions.push({
      kind: "target",
      rect: edgeRect(edge, inside(start, edgeRect(edge, 24)) ? 0 : 12),
      target: { kind: "split", stackId: root.id, index, direction: axis },
    });
  const stacks: { node: CodeStack; box: Rect; children: Rect[] }[] = [],
    leaves: { id: string; box: Rect; parent: CodeStack; index: number }[] = [];
  const walk = (node: CodeNode, owner?: CodeStack, index = 0) => {
    const box = rects.get(nodeKey(node));
    if (!box) return;
    if (node.kind === "tile") {
      if (owner) leaves.push({ id: node.tileId, box, parent: owner, index });
      return;
    }
    for (let at = 0; at < node.children.length; at++)
      walk(node.children[at], node, at);
    stacks.push({
      node,
      box,
      children: node.children.flatMap((child) => {
        const found = rects.get(nodeKey(child));
        return found ? [found] : [];
      }),
    });
  };
  walk(root);
  const pair = parent.children.length === 2 ? parent : undefined;
  for (const leaf of leaves) {
    if (leaf.id === id) continue;
    const axis = leaf.parent.direction === "row" ? "column" : "row",
      same = !!pair && leaf.parent.id === pair.id;
    const [first, last] = strips(leaf.box, axis, same);
    const target = (index: number): CodeDrop =>
      same && pair
        ? { kind: "split", stackId: pair.id, direction: axis, index }
        : { kind: "wrap", tileId: leaf.id, direction: axis, index };
    const shift =
      axis === "column" &&
      leaf.parent.id === parent.id &&
      start.y >= first.top &&
      start.y <= first.bottom;
    regions.push(
      {
        kind: "target",
        rect: shift
          ? rect(first.left, first.bottom, first.width, first.height)
          : first,
        target: target(0),
      },
      { kind: "target", rect: last, target: target(1) },
    );
  }
  const own = rects.get(id)!;
  strips(own, parent.direction === "row" ? "column" : "row", true).forEach(
    (box, index) => {
      if (!inside(start, box))
        regions.push({
          kind: "target",
          rect: box,
          target: {
            kind: "split",
            stackId: parent.id,
            direction: parent.direction === "row" ? "column" : "row",
            index,
          },
          ownStrip: true,
        });
    },
  );
  const parentBox = rects.get(parent.id);
  if (parentBox && parent.children.length > 1)
    regions.push({
      kind: "rearrange",
      rect: parentBox,
      stackId: parent.id,
      direction: parent.direction,
    });
  for (const { node, box, children } of stacks) {
    if (node.id === parent.id || !children.length) continue;
    const row = node.direction === "row";
    let cursor = row ? box.left : box.top;
    children.forEach((child, index) => {
      const end = row
        ? child.left + child.width / 2
        : child.top + child.height / 2;
      regions.push({
        kind: "target",
        rect: row
          ? rect(cursor, box.top, end - cursor, box.height)
          : rect(box.left, cursor, box.width, end - cursor),
        target: { kind: "insert", stackId: node.id, index },
      });
      cursor = end;
    });
    regions.push({
      kind: "target",
      rect: row
        ? rect(cursor, box.top, box.right - cursor, box.height)
        : rect(box.left, cursor, box.width, box.bottom - cursor),
      target: { kind: "insert", stackId: node.id, index: children.length },
    });
  }
  for (const leaf of leaves) {
    if (leaf.id === id || leaf.parent.id === parent.id) continue;
    const row = leaf.parent.direction === "row",
      box = leaf.box;
    regions.push(
      {
        kind: "target",
        rect: row
          ? rect(box.left, box.top, box.width / 2, box.height)
          : rect(box.left, box.top, box.width, box.height / 2),
        target: { kind: "insert", stackId: leaf.parent.id, index: leaf.index },
      },
      {
        kind: "target",
        rect: row
          ? rect(box.left + box.width / 2, box.top, box.width / 2, box.height)
          : rect(box.left, box.top + box.height / 2, box.width, box.height / 2),
        target: {
          kind: "insert",
          stackId: leaf.parent.id,
          index: leaf.index + 1,
        },
      },
    );
  }
  const duplicate = new Set([topology(layout)]);
  if (parent.children.length > 1)
    for (let index = 0; index < parent.children.length; index++)
      duplicate.add(
        topology(
          applyCodeDrop(layout, id, {
            kind: "insert",
            stackId: parent.id,
            index,
          }),
        ),
      );
  const special = (region: Extract<DropRegion, { kind: "target" }>) =>
    (region.target.kind === "split" &&
      (region.target.stackId === root.id ||
        region.target.stackId === pair?.id)) ||
    region.ownStrip === true;
  const tag = (
    region: Extract<DropRegion, { kind: "target" }>,
    shape: string,
  ) =>
    region.target.kind === "insert" &&
    !!findStack(parent, region.target.stackId)
      ? `nested:${shape}`
      : shape;
  const area = (box: Rect) =>
    Math.max(
      0,
      Math.min(box.right, outer.right) - Math.max(box.left, outer.left),
    ) *
    Math.max(
      0,
      Math.min(box.bottom, outer.bottom) - Math.max(box.top, outer.top),
    );
  const best = new Map<string, Extract<DropRegion, { kind: "target" }>>();
  for (const region of regions)
    if (region.kind === "target") {
      const shape = topology(applyCodeDrop(layout, id, region.target));
      if (duplicate.has(shape) || special(region)) continue;
      const key = tag(region, shape),
        previous = best.get(key);
      if (!previous || area(region.rect) > area(previous.rect))
        best.set(key, region);
    }
  const used = new Set<string>();
  return {
    id,
    parent,
    start,
    rects,
    regions: regions.filter((region) => {
      if (region.kind === "rearrange") return true;
      const shape = topology(applyCodeDrop(layout, id, region.target)),
        key = tag(region, shape);
      if (duplicate.has(shape)) return false;
      if (special(region)) return true;
      if (best.get(key) !== region || used.has(key)) return false;
      used.add(key);
      return true;
    }),
  };
}
export function codeDragResult(
  layout: CodeLayout,
  snapshot: CodeDragSnapshot,
  point: Point,
): { layout?: CodeLayout; target?: CodeDrop } {
  if (Math.hypot(point.x - snapshot.start.x, point.y - snapshot.start.y) < 16)
    return {};
  const source = snapshot.rects.get(snapshot.id)!,
    row = snapshot.parent.direction === "row";
  const from = row ? source.left : source.top,
    to = row ? source.right : source.bottom,
    shift = to - from + 12;
  const sourceIndex = snapshot.parent.children.findIndex(
    (node) => node.kind === "tile" && node.tileId === snapshot.id,
  );
  const moved = snapshot.parent.children.flatMap((node, index) => {
    const box = snapshot.rects.get(nodeKey(node));
    if (!box) return [];
    const at = row ? box.left : box.top,
      end = row ? box.right : box.bottom,
      back = at < from && index > sourceIndex;
    if (!back && !(at > from && index < sourceIndex)) return [];
    return [
      {
        node,
        offset:
          at < to && end > from
            ? null
            : row
              ? { x: back ? shift : -shift, y: 0 }
              : { x: 0, y: back ? shift : -shift },
      },
    ];
  });
  const inNode = (target: CodeDrop, node: CodeNode) =>
    target.kind === "wrap"
      ? codeTileIds(node).includes(target.tileId)
      : !!findStack(node, target.stackId);
  const region = snapshot.regions.find(
    (region) =>
      inside(point, region.rect) &&
      !(
        region.kind === "target" &&
        moved.some(
          ({ node, offset }) =>
            inNode(region.target, node) &&
            (offset === null ||
              !inside(
                { x: point.x - offset.x, y: point.y - offset.y },
                region.rect,
              )),
        )
      ),
  );
  if (!region) return {};
  if (region.kind === "target")
    return {
      layout: applyCodeDrop(layout, snapshot.id, region.target),
      target: region.target,
    };
  const parent = findStack(layout.root, region.stackId);
  if (!parent) return {};
  let index = sourceIndex;
  const coordinate = row ? point.x : point.y;
  parent.children.forEach((node, at) => {
    if (at === sourceIndex) return;
    const box = snapshot.rects.get(nodeKey(node));
    if (!box) return;
    const middle = row ? box.left + box.width / 2 : box.top + box.height / 2;
    if (sourceIndex > at && coordinate < middle) index = Math.min(index, at);
    if (sourceIndex < at && coordinate > middle) index = Math.max(index, at);
  });
  if (index !== sourceIndex) {
    const target: CodeDrop = { kind: "insert", stackId: parent.id, index };
    return { layout: applyCodeDrop(layout, snapshot.id, target), target };
  }
  const nested = snapshot.regions.find(
    (region) =>
      region.kind === "target" &&
      region.target.kind === "insert" &&
      inside(point, region.rect) &&
      !moved.some(({ node }) => inNode(region.target, node)) &&
      !!findStack(parent, region.target.stackId),
  );
  return nested?.kind === "target"
    ? {
        layout: applyCodeDrop(layout, snapshot.id, nested.target),
        target: nested.target,
      }
    : {};
}

/** ca67f2c9d/ot,jt: a3px edge indicator,6px out in the12px gap. */
export function codeDropIndicator(
  layout: CodeLayout,
  boxes: Map<string, CodeRect>,
  target: CodeDrop,
): CodeRect | undefined {
  let box: CodeRect | undefined,
    axis: CodeAxis,
    index = target.index;
  if (target.kind === "wrap") {
    box = boxes.get(target.tileId);
    axis = target.direction;
  } else {
    const stack = findStack(layout.root, target.stackId);
    if (!stack) return;
    axis = target.kind === "split" ? target.direction : stack.direction;
    box = boxes.get(stack.id);
    if (
      axis === stack.direction &&
      index > 0 &&
      index < stack.children.length
    ) {
      const next = boxes.get(nodeKey(stack.children[index]));
      if (!next || !box) return;
      return axis === "row"
        ? { left: next.left - 6, top: box.top, width: 3, height: box.height }
        : { left: box.left, top: next.top - 6, width: box.width, height: 3 };
    }
  }
  if (!box) return;
  return axis === "row"
    ? {
        left: index === 0 ? box.left - 6 : box.left + box.width + 6 - 3,
        top: box.top,
        width: 3,
        height: box.height,
      }
    : {
        left: box.left,
        top: index === 0 ? box.top - 6 : box.top + box.height + 6 - 3,
        width: box.width,
        height: 3,
      };
}
