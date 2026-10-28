import type {
  BillingCheckout,
  BillingInfo,
  BillingOrder,
  PaymentRequest,
  PaymentStarted,
} from "../../shared/billing-api";
import type { AppEvent } from "../../shared/types";
import { ClaudexPayment } from "../sub2api/claudex-payment";
import type { RedeemedCode, RemoteSubscription } from "../sub2api/client";
import type { PlanChoice } from "../sub2api/provision";
import {
  visibleMethod,
  checkoutFrom,
  paymentLaunch,
  OrderWatcher,
  type BillingHost,
  type PaymentFeatures,
  bootstrapOf,
} from "./billing-payments";

/**
 * Settings → Billing from the service's profile and subscriptions, and the
 * in-app payments (package C5): which methods the desktop app can use, how
 * a created order is paid, and following it until it settles. End users
 * never go to the service's web console, which is for administrators.
 */
export function billingFrom(input: {
  balance: number;
  plan?: PlanChoice;
  subscriptions: RemoteSubscription[];
  redeem?: boolean;
}): BillingInfo {
  const subscribed = input.plan?.subscribed ? input.plan : undefined;
  return {
    plan: subscribed?.name ?? null,
    planExpiresAt: subscribed?.expiresAt ?? null,
    balance: Math.round(input.balance * 100) / 100,
    subscriptions: input.subscriptions
      .map((item) => ({
        id: item.id,
        plan: item.group?.name || `Plan ${item.groupId}`,
        status: item.status || "active",
        expiresAt: item.expiresAt,
      }))
      .sort((a, b) => (b.expiresAt ?? Infinity) - (a.expiresAt ?? Infinity)),
    ...(input.redeem === undefined ? {} : { redeem: input.redeem }),
  };
}

const usd = (value: number) => `$${value.toFixed(2)}`;

/** What a redeemed code did, in one sentence. */
export function redeemMessage(code: RedeemedCode) {
  switch (code.type) {
    case "balance":
      return `${usd(code.value)} was added to your balance.`;
    case "subscription":
      return `${code.groupName || "A plan"} was added${
        code.validityDays ? ` for ${code.validityDays} days` : ""
      }.`;
    case "concurrency":
      return `You can now run ${code.value} more requests at once.`;
    default:
      return "The code was redeemed.";
  }
}

/**
 * Settings → Billing for one signed-in account: plans, orders, redeem codes
 * and following the orders placed in this session. Checkout pages open in
 * the system browser straight from here, never through the window's link
 * rules, and only for a page the service returned for an order this
 * session created.
 */
export class BillingSession {
  readonly payment: ClaudexPayment;
  private features?: PaymentFeatures;
  /** Methods found unusable from the desktop app in this session. */
  private unusable = new Set<string>();
  /** Browser pages of this session's pending orders, for "Open again". */
  private pages = new Map<number, string>();
  readonly watcher: OrderWatcher;
  constructor(
    readonly host: BillingHost,
    private deps: {
      openExternal(url: string): Promise<void>;
      push(event: AppEvent): void;
      /** False once this account signed out. */
      active(): boolean;
      payment?: ClaudexPayment;
      watcher?: Partial<ConstructorParameters<typeof OrderWatcher>[0]>;
    },
  ) {
    this.payment = deps.payment ?? new ClaudexPayment(host.accounts.baseUrl);
    this.watcher = new OrderWatcher({
      read: (orderId) =>
        this.authorized((token) => this.payment.order(token, orderId)),
      onStatus: (order) => {
        if (!deps.active()) return;
        if (order.status !== "PENDING") this.pages.delete(order.id);
        deps.push({
          type: "billing-order",
          orderId: order.id,
          status: order.status,
        });
      },
      // A plan or balance bought can change the models this device may use.
      onCompleted: () => (deps.active() ? host.refreshPlan() : undefined),
      active: deps.active,
      ...deps.watcher,
    });
  }
  private authorized<T>(call: (token: string) => Promise<T>) {
    return this.host.backend.session.authorized(call);
  }
  /** Payment, desktop checkout and redeem as the service reports them. */
  async paymentFeatures(): Promise<PaymentFeatures> {
    const current = bootstrapOf(this.host)?.current()?.features;
    if (current) return (this.features = current);
    const features = await this.authorized((token) =>
      this.payment.features(token),
    );
    if (features) return (this.features = features);
    // A Sub2API service without the Claudex extensions: no desktop checkout.
    const payment = await this.authorized((token) =>
      this.payment.enabled(token),
    ).catch(() => false);
    return (this.features = {
      payment,
      desktopCheckout: false,
      redeem: true,
    });
  }
  async info(): Promise<BillingInfo> {
    const backend = this.host.backend;
    const [user, subscriptions, features] = await Promise.all([
      this.authorized((token) => backend.client.profile(token)),
      this.authorized((token) => backend.client.subscriptions(token)),
      this.paymentFeatures().catch(() => undefined),
    ]);
    return billingFrom({
      balance: user.balance,
      plan: backend.plan,
      subscriptions,
      redeem: features?.redeem ?? true,
    });
  }
  async checkout(): Promise<BillingCheckout | null> {
    const features = await this.paymentFeatures();
    if (!features.payment) return null;
    const info = await this.authorized((token) =>
      this.payment.checkoutInfo(token),
    );
    const checkout = checkoutFrom(
      info,
      features.desktopCheckout,
      this.unusable,
    );
    return checkout.methods.length ? checkout : null;
  }
  async start(request: PaymentRequest): Promise<PaymentStarted> {
    const features = this.features ?? (await this.paymentFeatures());
    if (!features.payment)
      throw new Error("Payments are turned off on this service.");
    const method = visibleMethod(request.method);
    if (!method || this.unusable.has(method))
      throw new Error("This payment method isn't available.");
    const created = await this.authorized((token) =>
      this.payment.createOrder(token, {
        paymentType: method,
        orderType: request.planId ? "subscription" : "balance",
        planId: request.planId,
        amount: request.amount,
        returnUrl: this.payment.returnUrl,
        isMobile: request.mobile ?? false,
      }),
    );
    const launch = paymentLaunch(created, features.desktopCheckout);
    const order: BillingOrder = {
      id: created.orderId,
      kind: request.planId ? "subscription" : "balance",
      planId: request.planId ?? null,
      amount: created.amount,
      payAmount: created.payAmount || created.amount,
      currency: created.currency,
      method,
      status: created.status,
      createdAt: Date.now(),
      expiresAt: created.expiresAt,
      paidAt: null,
      completedAt: null,
    };
    if (launch.kind === "unavailable") {
      if (launch.hideMethod) this.unusable.add(method);
      // The order cannot be paid from here; it should not stay pending.
      await this.authorized((token) =>
        this.payment.cancel(token, created.orderId),
      ).catch(() => {});
      throw new Error(launch.message);
    }
    let page: string | undefined;
    if (launch.kind === "open") page = launch.url;
    if (launch.kind === "checkout") {
      const link = await this.authorized((token) =>
        this.payment.checkoutLink(token, launch.request),
      ).catch(async (error: unknown) => {
        await this.authorized((token) =>
          this.payment.cancel(token, created.orderId),
        ).catch(() => {});
        throw error;
      });
      page = this.payment.desktopPayUrl(link.token);
    }
    this.watcher.watch(order.id, order.expiresAt);
    if (page) {
      this.pages.set(order.id, page);
      await this.deps.openExternal(page);
      return { kind: "browser", order };
    }
    return { kind: "qr", order, qrCode: (launch as { qrCode: string }).qrCode };
  }
  async reopen(orderId: number) {
    const page = this.pages.get(orderId);
    if (!page)
      throw new Error(
        "This order's payment page can't be opened again. Cancel it and start a new one.",
      );
    await this.deps.openExternal(page);
  }
  orders(page: number) {
    return this.authorized((token) => this.payment.orders(token, page));
  }
  async order(orderId: number) {
    const order = await this.authorized((token) =>
      this.payment.order(token, orderId),
    );
    return order;
  }
  async cancel(orderId: number) {
    await this.authorized((token) => this.payment.cancel(token, orderId));
    this.watcher.stop(orderId);
    this.pages.delete(orderId);
    return this.order(orderId);
  }
  close() {
    this.watcher.stopAll();
    this.pages.clear();
  }
}
