import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOLTIP_CLOSE_DELAY_MS,
  TOOLTIP_DELAY_MS,
  TOOLTIP_WARM_MS,
  claim,
  createTooltipGroup,
  isWarm,
  release,
} from "../../src/ui/tooltip-group";
import { tooltipGap, tooltipOrigin } from "../../src/ui/tooltip-position";

test("tooltips wait 300ms, stay 200ms, and show at once while the group is warm", () => {
  const group = createTooltipGroup();
  assert.equal(group.delay, TOOLTIP_DELAY_MS);
  assert.equal(group.closeDelay, TOOLTIP_CLOSE_DELAY_MS);
  assert.equal(TOOLTIP_DELAY_MS, 300);
  assert.equal(TOOLTIP_CLOSE_DELAY_MS, 200);
  assert.equal(isWarm(group, 1000), false);

  const closed: string[] = [];
  const first = { closeInstant: () => closed.push("first") };
  const second = { closeInstant: () => closed.push("second") };
  claim(group, first);
  assert.equal(isWarm(group, 1000), true);
  // The next trigger's tooltip takes over: the first goes at once.
  claim(group, second);
  assert.deepEqual(closed, ["first"]);
  // The first closing late does not end the second's turn.
  release(group, first, 1100);
  assert.equal(group.current, second);

  release(group, second, 2000);
  assert.equal(isWarm(group, 2000 + TOOLTIP_WARM_MS - 1), true);
  assert.equal(isWarm(group, 2000 + TOOLTIP_WARM_MS), false);
});

test("a tooltip sits 4px from its button and grows from the side facing it", () => {
  assert.equal(tooltipGap, 4);
  const box = { left: 100, right: 132, top: 10, bottom: 42 };
  const size = { width: 80, height: 24 };
  assert.equal(
    tooltipOrigin(box, { left: 76, top: 46 }, size, "below"),
    "40px 0",
  );
  assert.equal(
    tooltipOrigin(box, { left: 76, top: -18 }, size, "above"),
    "40px 100%",
  );
  // Ending before the button: the origin is its right edge.
  assert.equal(
    tooltipOrigin(box, { left: 16, top: 46 }, size, "below-before"),
    "80px 0",
  );
  assert.equal(
    tooltipOrigin(box, { left: 140, top: 14 }, size, "right"),
    "0 12px",
  );
});
