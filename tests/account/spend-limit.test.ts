import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSpendAmount,
  spendLimitLine,
} from "../../src/settings/billing/SpendLimit";

test("the spend limit line and the amount field read like the original's", () => {
  assert.equal(
    spendLimitLine({ limitUsd: 50, usedUsd: 12.5, resetsAt: "" }),
    "$12.50 of $50 this month",
  );
  assert.equal(
    spendLimitLine({ limitUsd: null, usedUsd: 3, resetsAt: "" }),
    "$3.00 this month · No spend limit",
  );
  // A limit with cents keeps them; a whole one drops them.
  assert.equal(
    spendLimitLine({ limitUsd: 20.5, usedUsd: 12.5, resetsAt: "" }),
    "$12.50 of $20.50 this month",
  );
  assert.equal(parseSpendAmount("20"), 20);
  assert.equal(parseSpendAmount("$1,250.50"), 1250.5);
  assert.equal(parseSpendAmount("0"), 0);
  assert.equal(parseSpendAmount("20.505"), null);
  assert.equal(parseSpendAmount("abc"), null);
  assert.equal(parseSpendAmount("200000"), null);
});
