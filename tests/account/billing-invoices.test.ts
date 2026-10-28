import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BillingOrder } from "../../shared/billing-api";
import { Invoices, invoiceCsv } from "../../src/settings/billing/Invoices";

const order = (patch: Partial<BillingOrder>): BillingOrder => ({
  id: 7,
  kind: "balance",
  planId: null,
  amount: 10,
  payAmount: 10.3,
  currency: "USD",
  method: "alipay",
  status: "COMPLETED",
  createdAt: Date.UTC(2026, 9, 1, 12),
  expiresAt: null,
  paidAt: Date.UTC(2026, 9, 1, 12, 5),
  completedAt: null,
  ...patch,
});
const render = (items: BillingOrder[], pages = 1) =>
  renderToStaticMarkup(
    createElement(Invoices, {
      orders: { items, page: 1, pages, total: items.length },
      plans: [],
      onPay() {},
      onCancel() {},
      onMore() {},
      loadingMore: false,
    }),
  );

test("orders show as the original's invoice table", () => {
  assert.match(render([]), /We have not sent you an invoice yet\./);
  const html = render(
    [
      order({}),
      order({ id: 8, status: "PENDING" }),
      order({ id: 9, status: "EXPIRED" }),
    ],
    2,
  );
  assert.match(
    html,
    /<th>Date<\/th><th>Total<\/th><th>Status<\/th><th>Actions<\/th>/,
  );
  assert.match(html, /View details/);
  assert.match(html, /Pay<\/button> · <button[^>]*>Cancel/);
  assert.match(html, /billing-invoice-status muted/);
  assert.match(html, /Load more/);
  // Fees over the price get the Price / Fees tooltip.
  assert.match(html, /title="Price: \$10\.00\nFees: \$0\.30"/);
});

test("an invoice downloads as CSV with its lines", () => {
  const csv = invoiceCsv(order({}), []);
  assert.match(csv, /^"Invoice number","#7"\r\n/);
  assert.match(csv, /"Item","Added funds"/);
  assert.match(csv, /"Total","\$10\.30"/);
});
