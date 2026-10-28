import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  codeDragSnapshot,
  codeDragResult,
  codeDropIndicator,
} from "../../src/app/code-pane-drag";
import {
  resolveCodeLayout,
  type CodeNode,
} from "../../src/app/code-pane-layout-model";
const reference = JSON.parse(
  readFileSync(
    new URL("../fixtures/code-pane-drag-reference.json", import.meta.url),
    "utf8",
  ),
);
const shape = (node: CodeNode): unknown =>
  node.kind === "tile"
    ? { kind: node.kind, tileId: node.tileId, flex: node.flex }
    : {
        kind: node.kind,
        direction: node.direction,
        flex: node.flex,
        children: node.children.map(shape),
      };
test("native drag strips, nested grouping and rearrangement match640 official pointer outcomes", () => {
  let count = 0;
  for (const item of reference.cases) {
    const geometry = resolveCodeLayout(item.layout, 1400, 900);
    const snapshot = codeDragSnapshot(
      item.layout,
      geometry.rects,
      item.id,
      item.start,
    )!;
    assert.ok(snapshot);
    for (const point of item.points) {
      const result = codeDragResult(item.layout, snapshot, point);
      assert.deepEqual(
        result.layout ? shape(result.layout.root) : null,
        point.expected,
        `${item.id}@${point.x},${point.y}`,
      );
      count++;
    }
    assert.equal(
      codeDragResult(item.layout, snapshot, item.start).layout,
      undefined,
    );
  }
  assert.equal(count, 640);
  const sample = reference.cases[0],
    geometry = resolveCodeLayout(sample.layout, 1400, 900);
  const box = geometry.rects.get("files")!;
  assert.deepEqual(
    codeDropIndicator(sample.layout, geometry.rects, {
      kind: "wrap",
      tileId: "files",
      direction: "column",
      index: 0,
    }),
    { left: box.left, top: box.top - 6, width: box.width, height: 3 },
  );
});
