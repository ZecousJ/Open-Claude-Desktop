import test from "node:test";
import assert from "node:assert/strict";
import HandBlocks from "../../src/ui/pictograms/HandBlocks";
import ObjectShapes from "../../src/ui/pictograms/ObjectShapes";

test("the empty-state pictograms carry the original's highlight and lines", () => {
  for (const def of [HandBlocks, ObjectShapes]) {
    assert.ok(def.highlight.length > 0);
    assert.ok(def.line.length > 0);
    for (const path of [...def.highlight, ...def.line])
      assert.match(
        String(typeof path === "string" ? path : (path as { d: string }).d),
        /^M/,
      );
  }
  assert.equal(
    HandBlocks.highlight[0],
    "M315.261 194.184H203.965V294.35h111.296z",
  );
});

test("the magnifier pictogram is the original's: a lens highlight and an outline", async () => {
  const { default: ObjectMagnifier } =
    await import("../../src/ui/pictograms/ObjectMagnifier");
  assert.equal(ObjectMagnifier.highlight.length, 1);
  assert.ok(ObjectMagnifier.line.length > 0);
  assert.match(
    ObjectMagnifier.highlight[0],
    /^M162 266\.174c62\.408 0 113-50\.592/,
  );
});
