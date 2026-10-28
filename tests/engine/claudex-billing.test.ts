import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AppEvent } from "../../shared/types";
import type { BillingOrder } from "../../shared/billing-api";
import { BillingSession } from "../../electron/account/billing";
import {
  billingError,
  checkoutFrom,
  OrderWatcher,
  paymentLaunch,
  paymentMethods,
} from "../../electron/account/billing-payments";
import {
  balanceQuote,
  countdown,
  money,
  planQuote,
  statusLabel,
} from "../../src/settings/billing/quote";
import {
  parseCheckoutInfo,
  parseCreatedOrder,
} from "../../electron/sub2api/claudex-payment";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import { requestJson, Sub2ApiError } from "../../electron/sub2api/http";
import { MockSub2Api, ok, type MockOptions } from "../support/sub2api-mock";

type Json = Record<string, unknown>;
const user = {
  id: 3,
  email: "bob@example.test",
  password: "bob-password",
  balance: 4.5,
};
const pro = {
  id: 4,
  name: "Claudex Pro",
  platform: "openai",
  subscription_type: "subscription",
  status: "active",
};
const proPlan = {
  id: 7,
  group_id: 4,
  group_name: "Claudex Pro",
  name: "Pro monthly",
  description: "Five times the usage of the free plan",
  price: 20,
  original_price: 25,
  validity_days: 30,
  validity_unit: "day",
  features: ["All models", "Priority"],
};

async function start(t: TestContext, options: MockOptions = {}) {
  const mock = new MockSub2Api({ users: [user], groups: [pro], ...options });
  await mock.start();
  t.after(() => mock.close());
  // The mock has no `GET /subscriptions` (every subscription, expired ones too).
  mock.route("GET", "/api/v1/subscriptions", () => ok([]));
  const login = (await requestJson(fetch, `${mock.url}/api/v1/auth/login`, {
    method: "POST",
    body: { email: user.email, password: user.password },
  })) as Json;
  const token = String(login.access_token);
  const opened: string[] = [];
  const events: AppEvent[] = [];
  let refreshed = 0;
  let active = true;
  const timers: (() => void)[] = [];
  const host = {
    backend: {
      session: {
        authorized: <T>(call: (token: string) => Promise<T>) => call(token),
      },
      client: new Sub2ApiClient(mock.url),
    },
    accounts: { baseUrl: mock.url },
    refreshPlan: async () => {
      refreshed++;
    },
  };
  const billing = new BillingSession(host, {
    openExternal: async (url) => {
      opened.push(url);
    },
    push: (event) => events.push(event),
    active: () => active,
    // Timers are run by hand.
    watcher: { setTimer: (run) => timers.push(run), clearTimer: () => {} },
  });
  return {
    mock,
    billing,
    opened,
    events,
    timers,
    get refreshed() {
      return refreshed;
    },
    signOut() {
      active = false;
    },
  };
}
const payments = (types?: string[]): MockOptions => ({
  payment: { enabled: true, types, plans: [proPlan] },
});

test("Billing lists nothing to buy when the service has payments off", async (t) => {
  const { billing, mock } = await start(t);
  assert.equal(await billing.checkout(), null);
  const info = await billing.info();
  assert.equal(info.balance, 4.5);
  assert.equal(info.redeem, true);
  assert.ok(!mock.calls.includes("GET /api/v1/payment/checkout-info"));
});

test("plans and methods come from checkout-info; Stripe and Airwallex need the desktop checkout", async (t) => {
  const { billing, mock } = await start(t, payments());
  const checkout = (await billing.checkout())!;
  assert.deepEqual(
    checkout.methods.map((method) => [
      method.id,
      method.route,
      method.currency,
    ]),
    [
      ["alipay", "direct", "CNY"],
      ["stripe", "browser", "USD"],
      ["airwallex", "browser", "USD"],
    ],
  );
  assert.equal(checkout.plans[0].name, "Pro monthly");
  assert.equal(checkout.plans[0].originalPrice, 25);
  assert.deepEqual(checkout.plans[0].features, ["All models", "Priority"]);
  assert.deepEqual(checkout.balance, { multiplier: 1, min: 1, max: 1000 });

  // The service does not serve /desktop-pay (or has no resume signing key).
  mock.route("GET", "/api/v1/claudex/bootstrap", () => {
    const boot = mock.bootstrapFor(3, {});
    (boot.features as Json).desktop_checkout = false;
    return ok(boot);
  });
  assert.deepEqual(
    (await billing.checkout())!.methods.map((method) => method.id),
    ["alipay"],
  );
});

test("a plain Sub2API service: payments from /payment/config and no browser checkout", async (t) => {
  const { billing, mock } = await start(t, { claudex: false, ...payments() });
  const checkout = (await billing.checkout())!;
  assert.deepEqual(
    checkout.methods.map((method) => method.id),
    ["alipay"],
  );
  assert.ok(mock.calls.includes("GET /api/v1/payment/config"));
});

test("an https pay_url opens in the system browser and the order is followed", async (t) => {
  const run = await start(t, payments());
  const started = await run.billing.start({ method: "alipay", amount: 20 });
  assert.equal(started.kind, "browser");
  assert.deepEqual(run.opened, [
    `https://pay.example.test/alipay/${started.order.id}`,
  ]);
  const created = run.mock.orders[0];
  assert.equal(created.order_type, "balance");
  assert.ok(run.billing.watcher.watching(started.order.id));
  // Opened again from the page's "Open again".
  await run.billing.reopen(started.order.id);
  assert.equal(run.opened.length, 2);
});

test("a QR code is handed to the window, not opened", async (t) => {
  const run = await start(t, payments(["wxpay"]));
  const started = await run.billing.start({ method: "wxpay", planId: 7 });
  assert.equal(started.kind, "qr");
  assert.equal(
    started.kind === "qr" && started.qrCode,
    `weixin://wxpay/bizpayurl?pr=${started.order.id}`,
  );
  assert.equal(run.mock.orders[0].order_type, "subscription");
  assert.equal(run.mock.orders[0].plan_id, 7);
  assert.deepEqual(run.opened, []);
});

test("Stripe and Airwallex open /desktop-pay with a one-time token; the client secret never goes into the URL", async (t) => {
  const run = await start(t, payments());
  for (const method of ["stripe", "airwallex"]) {
    const started = await run.billing.start({ method, amount: 30 });
    assert.equal(started.kind, "browser");
    const order = run.mock.orders.find((item) => item.id === started.order.id)!;
    const url = run.opened.at(-1)!;
    assert.match(
      url,
      new RegExp(`^${run.mock.url}/desktop-pay#t=[A-Za-z0-9_-]{16,}$`),
    );
    assert.ok(order.client_secret);
    assert.ok(!url.includes(order.client_secret), url);
    assert.ok(!url.includes(order.resume_token), url);
    // The page's public read works with the token from the fragment.
    const session = (await requestJson(
      fetch,
      `${run.mock.url}/api/v1/claudex/payment/checkout`,
      {
        method: "POST",
        body: { token: decodeURIComponent(url.split("#t=")[1]) },
      },
    )) as Json;
    assert.equal(session.order_id, order.id);
  }
  assert.equal(
    run.mock.calls.filter(
      (call) => call === "POST /api/v1/claudex/payment/checkout-links",
    ).length,
    2,
  );
});

test("without a resume token Stripe is refused, the order cancelled and the method hidden", async (t) => {
  const run = await start(t, payments());
  run.mock.route("POST", "/api/v1/payment/orders", () =>
    ok({
      order_id: 55,
      amount: 30,
      pay_amount: 30,
      status: "PENDING",
      payment_type: "stripe",
      client_secret: "pi_1_secret_x",
      currency: "USD",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  await assert.rejects(
    run.billing.start({ method: "stripe", amount: 30 }),
    /can't be used from the desktop app/,
  );
  assert.ok(run.mock.calls.includes("POST /api/v1/payment/orders/55/cancel"));
  assert.ok(
    !run.mock.calls.includes("POST /api/v1/claudex/payment/checkout-links"),
  );
  assert.deepEqual(run.opened, []);
  assert.deepEqual(
    (await run.billing.checkout())!.methods.map((method) => method.id),
    ["alipay", "airwallex"],
  );
});

test("a pay_url that is not https is never opened", async (t) => {
  const run = await start(t, payments());
  run.mock.route("POST", "/api/v1/payment/orders", () =>
    ok({
      order_id: 56,
      amount: 20,
      pay_amount: 20,
      status: "PENDING",
      payment_type: "alipay",
      pay_url: "http://pay.example.test/alipay/56",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  await assert.rejects(
    run.billing.start({ method: "alipay", amount: 20 }),
    /isn't secure/,
  );
  assert.deepEqual(run.opened, []);
  for (const payUrl of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pw@x.test/",
  ])
    assert.equal(
      paymentLaunch(parseCreatedOrder({ order_id: 1, pay_url: payUrl }), true)
        .kind,
      "unavailable",
    );
});

test("WeChat's in-app flows are not offered on the desktop", async (t) => {
  const run = await start(t, payments(["alipay", "wxpay"]));
  run.mock.route("POST", "/api/v1/payment/orders", () =>
    ok({
      order_id: 57,
      amount: 20,
      pay_amount: 20,
      status: "PENDING",
      payment_type: "wxpay",
      result_type: "oauth_required",
      oauth: { authorize_url: "https://open.weixin.qq.com/x" },
    }),
  );
  await assert.rejects(
    run.billing.start({ method: "wxpay", amount: 20 }),
    /WeChat/,
  );
  assert.deepEqual(run.opened, []);
  assert.deepEqual(
    (await run.billing.checkout())!.methods.map((method) => method.id),
    ["alipay"],
  );
});

test("the order is followed until it completes, then the plan is read again", async (t) => {
  const run = await start(t, payments());
  const started = await run.billing.start({ method: "alipay", planId: 7 });
  const order = run.mock.orders[0];
  const tick = async () => {
    const next = run.timers.shift();
    assert.ok(next, "a poll is scheduled");
    next();
    // Let the poll's request finish.
    for (
      let i = 0;
      i < 20 &&
      run.timers.length === 0 &&
      run.billing.watcher.watching(started.order.id);
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await tick();
  assert.deepEqual(run.events, [
    { type: "billing-order", orderId: order.id, status: "PENDING" },
  ]);
  order.status = "PAID";
  await tick();
  order.status = "COMPLETED";
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    run.events.map((event) => (event as { status: string }).status),
    ["PENDING", "PAID", "COMPLETED"],
  );
  assert.equal(run.refreshed, 1);
  assert.ok(!run.billing.watcher.watching(started.order.id));
  assert.equal(run.timers.length, 0);
});

test("polling stops on a terminal status, past the expiry and at sign-out", async () => {
  const origin = 1_000_000;
  let now = origin;
  let status = "PENDING";
  const seen: string[] = [];
  let completed = 0;
  const timers: (() => void)[] = [];
  let active = true;
  const order = (id: number): BillingOrder => ({
    id,
    kind: "balance",
    planId: null,
    amount: 1,
    payAmount: 1,
    currency: "CNY",
    method: "alipay",
    status,
    createdAt: origin,
    expiresAt: origin + 10_000,
    paidAt: null,
    completedAt: null,
  });
  const watcher = new OrderWatcher({
    read: async (id) => order(id),
    onStatus: (item) => seen.push(`${item.id}:${item.status}`),
    onCompleted: () => {
      completed++;
    },
    active: () => active,
    now: () => now,
    setTimer: (run) => timers.push(run),
    clearTimer: () => {},
  });
  // Cancelled elsewhere: stops without refreshing the plan.
  watcher.watch(1, origin + 10_000);
  await watcher.poll(1);
  status = "CANCELLED";
  await watcher.poll(1);
  assert.deepEqual(seen, ["1:PENDING", "1:CANCELLED"]);
  assert.equal(watcher.watching(1), false);
  assert.equal(completed, 0);

  // Still pending after its expiry: two more reads, then it stops.
  status = "PENDING";
  watcher.watch(2, origin + 10_000);
  now = origin + 11_000;
  await watcher.poll(2);
  await watcher.poll(2);
  assert.equal(watcher.watching(2), true);
  await watcher.poll(2);
  assert.equal(watcher.watching(2), false);

  // A failed read is retried; signing out stops everything.
  now = origin;
  const failing = new OrderWatcher({
    read: async () => {
      throw new Error("offline");
    },
    onStatus: () => assert.fail("no status"),
    onCompleted: () => assert.fail("not completed"),
    active: () => active,
    setTimer: (run) => timers.push(run),
    clearTimer: () => {},
  });
  failing.watch(3, null);
  await failing.poll(3);
  assert.equal(failing.watching(3), true);
  active = false;
  await failing.poll(3);
  assert.equal(failing.watching(3), false);
});

test("a completed order refreshes the plan before the window hears of it", async () => {
  const steps: string[] = [];
  let run: (() => void) | undefined;
  const watcher = new OrderWatcher({
    read: async (id) => ({
      id,
      kind: "subscription",
      planId: 7,
      amount: 1,
      payAmount: 1,
      currency: "CNY",
      method: "alipay",
      status: "COMPLETED",
      createdAt: 0,
      expiresAt: null,
      paidAt: null,
      completedAt: null,
    }),
    onStatus: (order) => steps.push(`event ${order.status}`),
    onCompleted: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      steps.push("plan refreshed");
    },
    setTimer: (next) => (run = next),
    clearTimer: () => {},
  });
  watcher.watch(9, null);
  assert.ok(run);
  await watcher.poll(9);
  assert.deepEqual(steps, ["plan refreshed", "event COMPLETED"]);
  assert.equal(watcher.watching(9), false);
});

test("orders are paged and a pending one can be cancelled", async (t) => {
  const run = await start(t, payments());
  for (let i = 0; i < 12; i++)
    await requestJson(fetch, `${run.mock.url}/api/v1/payment/orders`, {
      method: "POST",
      token: [...run.mock.accessTokens.keys()][0],
      body: { payment_type: "alipay", order_type: "balance", amount: i + 1 },
    });
  const first = await run.billing.orders(1);
  assert.equal(first.items.length, 10);
  assert.equal(first.pages, 2);
  assert.equal(first.total, 12);
  assert.equal(first.items[0].amount, 12, "newest first");
  assert.equal(first.items[0].currency, "CNY");
  const second = await run.billing.orders(2);
  assert.equal(second.items.length, 2);
  const cancelled = await run.billing.cancel(first.items[0].id);
  assert.equal(cancelled.status, "CANCELLED");
  await assert.rejects(
    run.billing.cancel(first.items[0].id),
    (error: unknown) =>
      (billingError(error) as Error).message ===
      "This order can no longer be cancelled.",
  );
});

test("redeem and payment errors read as sentences", () => {
  const message = (code: string, status = 400) =>
    (billingError(new Sub2ApiError(status, code, "raw")) as Error).message;
  assert.equal(
    message("REDEEM_CODE_NOT_FOUND", 404),
    "That code doesn't exist. Check it and try again.",
  );
  assert.equal(
    message("REDEEM_CODE_USED", 409),
    "That code has already been used.",
  );
  assert.equal(message("REDEEM_CODE_EXPIRED", 409), "That code has expired.");
  assert.equal(
    message("TOO_MANY_PENDING"),
    "You have too many unpaid orders. Pay or cancel one of them first.",
  );
  assert.equal(message("SOMETHING_NEW"), "raw");
  const offline = new Sub2ApiError(
    0,
    "UNREACHABLE",
    "The Claudex service is unreachable.",
  );
  assert.equal(billingError(offline), offline);
});

test("method aliases collapse to the canonical entry, unknown methods are left out", () => {
  const info = parseCheckoutInfo({
    methods: {
      alipay_direct: {
        payment_type: "alipay_direct",
        currency: "cny",
        single_min: 5,
      },
      alipay: { payment_type: "alipay", currency: "CNY", single_min: 1 },
      wxpay_direct: { payment_type: "wxpay_direct", currency: "CNY" },
      easypay: { payment_type: "easypay", currency: "CNY" },
      "bad type": { payment_type: "Bad Type" },
    },
    plans: [{ id: 1, name: "Free", price: 0 }, proPlan],
    balance_disabled: true,
    recharge_fee_rate: 3,
  });
  assert.deepEqual(
    paymentMethods(info, true).map((method) => [method.id, method.min]),
    [
      ["alipay", 1],
      ["wxpay", 0],
    ],
  );
  const checkout = checkoutFrom(info, true);
  assert.equal(checkout.balance, null);
  assert.equal(checkout.plans.length, 1, "a free plan is not sold");
  assert.equal(checkout.feeRate, 3);
  assert.equal(
    checkoutFrom(parseCheckoutInfo({ plans: [proPlan] }), true).plans.length,
    0,
  );
});

test("quotes add the fee, convert plan prices to CNY and check the method's limits", () => {
  const checkout = checkoutFrom(
    parseCheckoutInfo({
      methods: {
        alipay: {
          payment_type: "alipay",
          currency: "CNY",
          single_min: 5,
          single_max: 500,
        },
        stripe: { payment_type: "stripe", currency: "USD" },
      },
      plans: [proPlan],
      balance_recharge_multiplier: 0.14,
      subscription_usd_to_cny_rate: 7.1,
      recharge_fee_rate: 3,
      global_min: 1,
      global_max: 1000,
    }),
    true,
  );
  const [alipay, stripe] = checkout.methods;
  const topUp = balanceQuote(20, alipay, checkout);
  assert.deepEqual(
    [topUp.base, topUp.fee, topUp.total, topUp.credit, topUp.problem],
    [20, 0.6, 20.6, 2.8, undefined],
  );
  assert.match(
    balanceQuote(2, alipay, checkout).problem!,
    /smallest amount for Alipay is CN¥5\.00/,
  );
  assert.match(balanceQuote(600, alipay, checkout).problem!, /largest amount/);
  assert.equal(balanceQuote(NaN, alipay, checkout).problem, "Enter an amount.");
  assert.deepEqual(
    [
      planQuote(checkout.plans[0], alipay, checkout).base,
      planQuote(checkout.plans[0], stripe, checkout).base,
    ],
    [142, 20],
  );
  assert.equal(planQuote(checkout.plans[0], stripe, checkout).total, 20.6);
  assert.equal(money(20.6, "USD"), "$20.60");
  assert.match(money(1, "XQQ"), /XQQ.*1\.00|1\.00.*XQQ/);
  assert.equal(countdown(61_000, 0), "Expires in 1:01");
  assert.equal(countdown(1_000, 5_000), "This order has expired.");
  assert.equal(statusLabel("PENDING"), "Awaiting payment");
  assert.equal(statusLabel("SOMETHING_ELSE"), "Something else");
});
