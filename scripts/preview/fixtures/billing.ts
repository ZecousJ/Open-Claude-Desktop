/**
 * Settings → Billing and the in-app payments (package C5): plans, balance,
 * orders and redeem codes. Nothing is fetched or paid: the plans and
 * orders are synthetic, "browser" payments open nothing, and the QR code
 * encodes an example.com address.
 */
import type {
  BillingCheckout,
  BillingInfo,
  BillingOrder,
  PaymentStarted,
} from "../../../shared/billing-api";
import type { FixtureDomain } from "./index";

const day = 24 * 60 * 60 * 1000;

export const billingFixture: FixtureDomain = {
  params: {
    billing:
      "plan (default: a subscribed plan) | payg (pay as you go) | local (a local account: no billing)",
    payment: "off: the service has payments turned off",
    orders: "none: no orders yet",
    settle:
      "paid | expired: a started order moves on 1.5 s later (default: stays pending)",
  },
  bridge: ({ params, origin, emit }) => {
    const mode = params.get("billing") ?? "plan";
    const paymentOff = params.get("payment") === "off";
    const settle = params.get("settle");
    let balance = 12.4;
    const info = (): BillingInfo | null =>
      mode === "local"
        ? null
        : {
            plan: mode === "payg" ? null : "Claudex Pro",
            planExpiresAt: mode === "payg" ? null : origin + 23 * day,
            balance,
            subscriptions:
              mode === "payg"
                ? []
                : [
                    {
                      id: 1,
                      plan: "Claudex Pro",
                      status: "active",
                      expiresAt: origin + 23 * day,
                    },
                  ],
            redeem: true,
          };
    const checkout: BillingCheckout = {
      methods: [
        {
          id: "alipay",
          label: "Alipay",
          route: "direct",
          currency: "CNY",
          min: 1,
          max: 5000,
        },
        {
          id: "wxpay",
          label: "WeChat Pay",
          route: "direct",
          currency: "CNY",
          min: 1,
          max: 5000,
        },
        {
          id: "stripe",
          label: "Card (Stripe)",
          route: "browser",
          currency: "USD",
          min: 1,
          max: 1000,
        },
      ],
      plans: [
        {
          id: 7,
          name: "Claudex Pro",
          description: "Five times the usage of Standard",
          groupName: "Claudex Pro",
          price: 20,
          originalPrice: 25,
          validityDays: 30,
          validityUnit: "day",
          features: [],
        },
        {
          id: 8,
          name: "Claudex Max",
          description: "Twenty times the usage of Standard",
          groupName: "Claudex Max",
          price: 100,
          originalPrice: null,
          validityDays: 30,
          validityUnit: "day",
          features: [],
        },
      ],
      balance: { multiplier: 1, min: 1, max: 5000 },
      feeRate: 0,
      usdToCny: 7.1,
      helpText: "",
    };
    const order = (
      id: number,
      at: number,
      patch: Partial<BillingOrder>,
    ): BillingOrder => ({
      id,
      kind: "balance",
      planId: null,
      amount: 50,
      payAmount: 50,
      currency: "CNY",
      method: "alipay",
      status: "COMPLETED",
      createdAt: at,
      expiresAt: at + 30 * 60_000,
      paidAt: at + 60_000,
      completedAt: at + 61_000,
      ...patch,
    });
    const orders: BillingOrder[] =
      params.get("orders") === "none"
        ? []
        : [
            order(1043, origin - 2 * day, {
              kind: "subscription",
              planId: 7,
              amount: 142,
              payAmount: 142,
            }),
            order(1039, origin - 9 * day, {
              method: "stripe",
              currency: "USD",
              amount: 20,
              payAmount: 20,
            }),
            order(1031, origin - 16 * day, { status: "EXPIRED", paidAt: null }),
            order(1024, origin - 38 * day, {
              kind: "subscription",
              planId: 7,
              amount: 142,
              payAmount: 142,
            }),
          ];
    let next = 1050;
    const find = (id: number) => {
      const found = orders.find((item) => item.id === id);
      if (!found) throw new Error("Order not found.");
      return found;
    };
    return {
      billingInfo: async () => info(),
      billingCheckout: async () =>
        mode === "local" || paymentOff ? null : checkout,
      billingOrders: async (page) => ({
        items: orders.slice((page - 1) * 10, page * 10),
        page,
        pages: Math.max(1, Math.ceil(orders.length / 10)),
        total: orders.length,
      }),
      billingOrder: async (id) => ({ ...find(id) }),
      startPayment: async (request): Promise<PaymentStarted> => {
        const method = checkout.methods.find(
          (item) => item.id === request.method,
        )!;
        const plan = checkout.plans.find((item) => item.id === request.planId);
        const amount = plan
          ? method.currency === "CNY"
            ? Math.round(plan.price * checkout.usdToCny * 100) / 100
            : plan.price
          : request.amount!;
        const now = Date.now();
        const created = order(next++, now, {
          kind: plan ? "subscription" : "balance",
          planId: plan?.id ?? null,
          amount,
          payAmount: amount,
          currency: method.currency,
          method: method.id,
          status: "PENDING",
          expiresAt: now + 30 * 60_000,
          paidAt: null,
          completedAt: null,
        });
        orders.unshift(created);
        if (settle === "paid" || settle === "expired")
          setTimeout(() => {
            created.status = settle === "paid" ? "COMPLETED" : "EXPIRED";
            if (settle === "paid" && !plan) balance += amount;
            emit({
              type: "billing-order",
              orderId: created.id,
              status: created.status,
            });
          }, 1500);
        return method.route === "browser"
          ? { kind: "browser", order: { ...created } }
          : {
              kind: "qr",
              order: { ...created },
              qrCode: `https://pay.example.com/fixture/${created.id}`,
            };
      },
      reopenPayment: async () => {},
      cancelOrder: async (id) => {
        const found = find(id);
        found.status = "CANCELLED";
        emit({ type: "billing-order", orderId: id, status: "CANCELLED" });
        return { ...found };
      },
      redeemCode: async (code) => {
        if (code.trim().toUpperCase() !== "WELCOME-10")
          throw new Error("That code doesn't exist. Check it and try again.");
        balance += 10;
        return { message: "$10.00 was added to your balance.", billing: info() };
      },
    };
  },
};
