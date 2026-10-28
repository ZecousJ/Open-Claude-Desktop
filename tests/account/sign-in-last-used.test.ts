import test from "node:test";
import assert from "node:assert/strict";
import { tooltipPosition } from "../../src/ui/tooltip-position";

test("a left tooltip sits before its anchor, vertically centred", () => {
  const at = tooltipPosition(
    { left: 200, top: 100, right: 400, bottom: 140 },
    { width: 60, height: 20 },
    { width: 1000, height: 800 },
    "left",
  );
  assert.deepEqual(at, { left: 200 - 4 - 4 - 60, top: 110 });
});
