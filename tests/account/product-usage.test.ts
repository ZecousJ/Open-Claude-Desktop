import test from "node:test";
import assert from "node:assert/strict";
import { productRows } from "../../src/settings/usage-products/ProductUsage";
import { productUsageFrom } from "../../electron/ipc/usage";

test("usage by product shows each surface's share of the spend, largest first", () => {
  assert.deepEqual(
    productRows({ code: 3, chat: 1, cowork: 0 }).map((row) => [
      row.label,
      Math.round(row.percent),
    ]),
    [
      ["Claudex Code", 75],
      ["Chats", 25],
    ],
  );
  assert.deepEqual(productRows({}), []);
  const usage = productUsageFrom({
    from: "2026-10-10",
    to: "2026-10-17",
    totals: { code: 1.5, bogus: 9, other: -1 },
    requests: { code: 3 },
    days: [{ day: "2026-10-16", cost_usd: { code: 1.5 } }, null],
  });
  assert.deepEqual(usage?.totals, { code: 1.5 });
  assert.deepEqual(usage?.days, [
    { day: "2026-10-16", costUsd: { code: 1.5 } },
  ]);
});
