import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BillingOrder, PlanOffer } from "../../shared/billing-api";
import { Invoices, invoiceCsv } from "../../src/settings/billing/Invoices";
import { BillingTab } from "../../src/settings/tabs/Billing";
import { routineDom } from "../support/routine-dom";

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
const invoiceList = (items: BillingOrder[], pages = 1) =>
  createElement(Invoices, {
    orders: {
      kind: "ready",
      data: { items, page: 1, pages, total: items.length },
    },
    plans: [],
    onPay() {},
    onCancel() {},
    onPage() {},
  });
const render = (items: BillingOrder[], pages = 1) =>
  renderToStaticMarkup(invoiceList(items, pages));

test("orders show as the original's invoice table", () => {
  assert.match(render([]), /We have not sent you an invoice yet\./);
  const html = render(
    [
      order({}),
      order({ id: 8, status: "PENDING", paidAt: null }),
      order({ id: 9, status: "EXPIRED", paidAt: null }),
    ],
    2,
  );
  assert.match(
    html,
    /<th>Date<\/th><th>Total<\/th><th>Status<\/th><th>Actions<\/th>/,
  );
  assert.equal(html.match(/View details/g)?.length, 3);
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

test("CSV keeps a plan name with commas, quotes and line breaks in one text cell", () => {
  const plan = {
    id: 15,
    name: '=2026, "Team"\nMonthly',
    description: "",
    groupName: "Team",
    price: 10,
    originalPrice: null,
    validityDays: 30,
    validityUnit: "day",
    features: [],
  } satisfies PlanOffer;
  const csv = invoiceCsv(order({ kind: "subscription", planId: plan.id }), [
    plan,
  ]);
  assert.ok(csv.includes(`\r\n"Item","'=2026, ""Team""\nMonthly"\r\n`));
});

test("detail retries the order read and exports the same total it displays", async (t) => {
  const files: { filename: string; csv: string }[] = [];
  let firstRead = true;
  let firstSave = true;
  const e = await routineDom(
    {
      billingOrder: async (id) => {
        assert.equal(id, 7);
        if (firstRead) {
          firstRead = false;
          throw new Error("Service temporarily unavailable");
        }
        return order({ payAmount: 10.8 });
      },
      saveArtifact: async (filename, csv) => {
        if (firstSave) {
          firstSave = false;
          throw new Error("File could not be saved");
        }
        files.push({ filename, csv });
        return filename;
      },
    },
    { jsdom: true },
  );
  t.after(e.clean);
  const press = async (label: string) => {
    const button = [...e.document.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    );
    assert.ok(button, `${label} button is visible`);
    await e.event(button, "click");
  };

  await e.render(invoiceList([order({})]));
  await press("View details");
  const dialog = e.document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(
    dialog.querySelector('[role="alert"]')?.textContent ?? "",
    /Unable to load data/,
  );
  assert.equal(dialog.querySelector("iframe"), null);
  assert.doesNotMatch(dialog.textContent ?? "", /Download CSV/);
  await press("Try again");
  const invoice = dialog.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
  assert.match(invoice, /<th>Total<\/th><td>\$10\.80<\/td>/);
  assert.match(invoice, /<th>Fees<\/th><td>\$0\.80<\/td>/);
  await press("Download CSV");
  assert.match(
    dialog.querySelector('[role="alert"]')?.textContent ?? "",
    /Unable to save invoice/,
  );
  await press("Download CSV");
  assert.equal(dialog.querySelector('[role="alert"]'), null);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, "invoice-7.csv");
  assert.ok(files[0].csv.includes('"Total","$10.80"'));
  assert.ok(files[0].csv.includes('"Fees","$0.80"'));
  assert.ok(!files[0].csv.includes("$10.30"));
});

test("invoice history can retry a failed page and remains available without checkout offers", async (t) => {
  const pages = [1, 2];
  const e = await routineDom(
    {
      billingInfo: async () => ({
        plan: null,
        planExpiresAt: null,
        balance: 25,
        subscriptions: [],
      }),
      billingCheckout: async () => null,
      spendLimit: async () => null,
      billingOrders: async (page) => {
        const failure = pages.indexOf(page);
        if (failure !== -1) {
          pages.splice(failure, 1);
          throw new Error("Service temporarily unavailable");
        }
        return {
          items: [order({ id: page, payAmount: page * 20 })],
          page,
          pages: 2,
          total: 2,
        };
      },
    },
    { jsdom: true },
  );
  t.after(e.clean);
  const press = async (label: string) => {
    const button = [...e.document.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    );
    assert.ok(button, `${label} button is visible`);
    await e.event(button, "click");
  };
  const table = () => e.document.querySelector('table[aria-label="Invoices"]');
  const alert = () => e.document.querySelector('[role="alert"]');

  await e.render(
    createElement(BillingTab, {
      onError: (error) => {
        throw error;
      },
    }),
  );
  assert.ok(alert());
  assert.equal(table(), null);
  await press("Try again");
  assert.match(table()?.textContent ?? "", /\$20\.00/);
  await press("Load more");
  assert.ok(alert());
  assert.match(table()?.textContent ?? "", /\$20\.00/);
  await press("Try again");
  assert.equal(alert(), null);
  assert.equal(table()?.querySelectorAll("tbody tr").length, 2);
  assert.match(table()?.textContent ?? "", /\$40\.00/);
});

test("an expired order has its own details without an issued invoice", async (t) => {
  const expired = order({ id: 8, status: "EXPIRED", paidAt: null });
  const e = await routineDom(
    { billingOrder: async () => expired },
    { jsdom: true },
  );
  t.after(e.clean);

  await e.render(invoiceList([expired]));
  await e.click(".billing-invoice-actions button");
  const dialog = e.document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent ?? "", /Order detail/);
  assert.doesNotMatch(dialog.textContent ?? "", /Download CSV/);
  const document = dialog.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
  assert.match(document, /<th>Order number<\/th><td>#8<\/td>/);
  assert.match(document, /<th>Status<\/th><td>Expired<\/td>/);
});
