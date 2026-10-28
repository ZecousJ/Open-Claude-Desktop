import test from "node:test";
import assert from "node:assert/strict";
import { fitBackgroundPanelWidth } from "../../shared/background-panel-layout";
test("task panel gesture stays within the rail and leaves the conversation usable", () => {
  assert.equal(fitBackgroundPanelWidth(500, 1360), 500);
  assert.equal(fitBackgroundPanelWidth(900, 1360), 620);
  assert.equal(fitBackgroundPanelWidth(500, 598), 338);
  assert.equal(fitBackgroundPanelWidth(50, 598), 260);
  assert.equal(fitBackgroundPanelWidth(Number.NaN, 598), 260);
  assert.equal(fitBackgroundPanelWidth(500, 420), 220);
});
