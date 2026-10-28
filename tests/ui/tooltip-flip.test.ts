import test from "node:test";
import assert from "node:assert/strict";
import { tooltipOrigin, tooltipPosition } from "../../src/ui/tooltip-position";

// A button in the composer's chin sits a few pixels over the window's foot: its
// "below" tooltip, kept inside the window, would lie on the button and take the
// click meant for it. It goes above the button instead, growing from its foot.
test("a tooltip clamped onto its button flips to the other side", () => {
  const anchor = { left: 100, right: 124, top: 770, bottom: 794 };
  const size = { width: 120, height: 24 };
  const view = { width: 1280, height: 800 };
  const at = tooltipPosition(anchor, size, view, "below");
  assert.deepEqual(at, { left: 52, top: 742 });
  assert.equal(tooltipOrigin(anchor, at, size, "below"), "60px 100%");
  // And an "above" tooltip at the window's head goes below.
  const head = { left: 100, right: 124, top: 4, bottom: 28 };
  const under = tooltipPosition(head, size, view, "above");
  assert.deepEqual(under, { left: 52, top: 32 });
  assert.equal(tooltipOrigin(head, under, size, "above"), "60px 0");
});

test("a tooltip with room keeps its asked-for side", () => {
  const anchor = { left: 100, right: 124, top: 400, bottom: 424 };
  const size = { width: 120, height: 24 };
  const view = { width: 1280, height: 800 };
  assert.deepEqual(tooltipPosition(anchor, size, view, "below"), {
    left: 52,
    top: 428,
  });
  assert.deepEqual(tooltipPosition(anchor, size, view, "above"), {
    left: 52,
    top: 372,
  });
});
