import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WeeklyUsageStatus } from "../../shared/usage-api";
import { lowBalanceUsd } from "../../shared/billing-api";
import {
  balanceNotice,
  lowBalanceDue,
  noticeOrder,
  usageNotice,
} from "../../src/policy/notice-content";
import { NoticeView } from "../../src/policy/NoticeView";
import {
  onRechargeRequest,
  openRecharge,
  takeRechargeRequest,
} from "../../src/settings/billing/recharge";
import {
  balanceSnapshot,
  closeLowBalance,
  lowBalanceClosedFor,
  refreshBalance,
  resetLowBalanceForTests,
} from "../../src/policy/useLowBalance";

const refused: WeeklyUsageStatus = {
  used: 0,
  limit: 0,
  percent: 100,
  warnPercent: 80,
  resetsAt: Date.UTC(2026, 9, 19),
  moreUsageUrl: "https://usage.example.com",
  state: "exceeded",
  dismissed: false,
  unit: "usd",
  reason: "balance",
};

test("the low-balance warning is due below $10 until closed or refused", () => {
  assert.equal(lowBalanceUsd, 10);
  assert.equal(lowBalanceDue(9.99, false, null), true);
  assert.equal(lowBalanceDue(0, false, null), true);
  assert.equal(lowBalanceDue(10, false, null), false);
  assert.equal(lowBalanceDue(null, false, null), false);
  assert.equal(lowBalanceDue(4, true, null), false);
  // "Your balance is used up" already says it.
  assert.equal(lowBalanceDue(0, false, refused), false);
  assert.equal(lowBalanceDue(0, false, { ...refused, dismissed: true }), true);
  assert.equal(lowBalanceDue(3, false, { ...refused, reason: "weekly" }), true);
  // Stacked after announcements and before the usage window's warning.
  assert.ok(noticeOrder.indexOf("balance") < noticeOrder.indexOf("usage"));
});

test("the warning uses the usage frames with balance words and Add funds", () => {
  const chat = balanceNotice(4.2, "chat", true);
  assert.equal(chat.kind, "balance");
  assert.equal(chat.title, "You have $4.20 left in your balance");
  assert.equal(chat.detail, undefined);
  assert.equal(chat.icon, "info");
  assert.deepEqual(chat.action, { kind: "add-funds", label: "Add funds" });
  assert.equal(chat.dismissible, true);
  const code = balanceNotice(-1, "code", true);
  assert.equal(code.title, "Balance running low");
  assert.equal(code.detail, "$0.00 left in your balance");
  assert.equal(code.icon, "gauge");
  // No in-app payments: no button that would go nowhere.
  assert.equal(balanceNotice(4.2, "chat", false).action, undefined);
  const html = renderToStaticMarkup(
    createElement(NoticeView, {
      content: chat,
      surface: "chat",
      variant: "home",
      onAction: () => {},
      onDismiss: () => {},
    }),
  );
  assert.match(html, /data-notice="balance"/);
  assert.match(html, /usage-banner chat home warning/);
  assert.match(html, />Add funds</);
  assert.match(html, /aria-label="Dismiss"/);
});

test("a used-up balance offers the recharge entry when the app can take payments", () => {
  assert.deepEqual(usageNotice(refused, "service", "chat", true)!.action, {
    kind: "add-funds",
    label: "Add funds",
  });
  assert.deepEqual(usageNotice(refused, "service", "chat")!.action, {
    kind: "more-usage",
    label: "Get more usage",
  });
  // Other refusals keep the administrator's page.
  const weekly = { ...refused, reason: "weekly" as const };
  assert.equal(
    usageNotice(weekly, "usage", "chat", true)!.action!.kind,
    "more-usage",
  );
});

test("the recharge request opens Billing once and reaches an open page", () => {
  let opened = 0;
  let heard = 0;
  const off = onRechargeRequest(() => heard++);
  openRecharge(() => opened++);
  assert.equal(opened, 1);
  assert.equal(heard, 1);
  assert.equal(takeRechargeRequest(), true);
  assert.equal(takeRechargeRequest(), false);
  off();
  openRecharge(() => opened++);
  assert.equal(heard, 1);
  assert.equal(takeRechargeRequest(), true);
});

test("the balance is read from Billing, with whether Add funds is sold", async () => {
  const previous = (globalThis as { window?: unknown }).window;
  let balance = 6.5;
  let checkouts = 0;
  (globalThis as { window?: unknown }).window = {
    desktop: {
      billingInfo: async () => ({
        plan: null,
        planExpiresAt: null,
        balance,
        subscriptions: [],
      }),
      billingCheckout: async () => {
        checkouts++;
        return { balance: { multiplier: 1, min: 1, max: 0 } };
      },
      onEvent: () => () => {},
    },
  };
  try {
    resetLowBalanceForTests();
    await refreshBalance();
    assert.deepEqual(balanceSnapshot(), { balance: 6.5, canAddFunds: true });
    closeLowBalance("a@example.com");
    assert.equal(lowBalanceClosedFor("a@example.com"), true);
    assert.equal(lowBalanceClosedFor("b@example.com"), false);
    // Topped up: the warning comes back after a later drop.
    balance = 25;
    await refreshBalance();
    assert.equal(balanceSnapshot().balance, 25);
    assert.equal(lowBalanceClosedFor("a@example.com"), false);
    // What the service sells is read once per account.
    assert.equal(checkouts, 1);
  } finally {
    resetLowBalanceForTests();
    (globalThis as { window?: unknown }).window = previous;
  }
});
