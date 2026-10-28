import type {
  BillingCheckout,
  BillingOrder,
  PaymentMethod,
} from "../../shared/billing-api";
import { orderIsOpen } from "../../shared/billing-api";
import {
  httpsUrl,
  type BootstrapSource,
  type CheckoutLinkRequest,
  type ClaudexFeatures,
} from "../../shared/claudex-contract";
import {
  type CheckoutInfo,
  type CreatedOrder,
} from "../sub2api/claudex-payment";
import type { Sub2ApiClient } from "../sub2api/client";
import { Sub2ApiError } from "../sub2api/http";
import type { PlanChoice } from "../sub2api/provision";

/** A service error in words the Billing page can show; others pass through. */
export function billingError(error: unknown): unknown {
  if (!(error instanceof Sub2ApiError)) return error;
  const message = redeemErrors[error.code] ?? paymentErrors[error.code];
  if (message) return new Error(message);
  // The service's own English message is shown when it has one.
  return error.status === 0 ? error : new Error(error.message);
}

// ---------------------------------------------------------------------------
// Payment methods

const methodAliases: Record<string, string> = {
  alipay: "alipay",
  alipay_direct: "alipay",
  wxpay: "wxpay",
  wxpay_direct: "wxpay",
  stripe: "stripe",
  airwallex: "airwallex",
};

const methodLabels: Record<string, string> = {
  alipay: "Alipay",
  wxpay: "WeChat Pay",
  stripe: "Card (Stripe)",
  airwallex: "Card (Airwallex)",
};

/** Paid on the service's /desktop-pay page, which needs B10. */
const browserMethods = new Set(["stripe", "airwallex"]);

/** The method a person picks, for a service payment type (alipay_direct → alipay). */
export const visibleMethod = (type: string) => methodAliases[type] ?? "";

export function methodLabel(type: string) {
  return methodLabels[visibleMethod(type)] ?? type;
}

/**
 * The methods the desktop app lists: the four it knows how to pay, the
 * canonical entry winning over an alias; Stripe and Airwallex only when the
 * service serves the desktop checkout page; none the app found unusable in
 * this session (WeChat's in-app flows, a missing resume token).
 */
export function paymentMethods(
  info: CheckoutInfo,
  desktopCheckout: boolean,
  unusable: ReadonlySet<string> = new Set(),
): PaymentMethod[] {
  const found = new Map<string, PaymentMethod & { canonical: boolean }>();
  for (const method of info.methods) {
    const id = visibleMethod(method.type);
    if (!id || unusable.has(id)) continue;
    if (browserMethods.has(id) && !desktopCheckout) continue;
    const canonical = method.type === id;
    if (found.has(id) && (found.get(id)!.canonical || !canonical)) continue;
    found.set(id, {
      id,
      label: methodLabels[id],
      route: browserMethods.has(id) ? "browser" : "direct",
      currency: method.currency || "CNY",
      min: method.singleMin,
      max: method.singleMax,
      canonical,
    });
  }
  const order = Object.keys(methodLabels);
  return [...found.values()]
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    .map(({ canonical: _canonical, ...method }) => method);
}

/** What Billing offers, from `checkout-info` and the service's features. */
export function checkoutFrom(
  info: CheckoutInfo,
  desktopCheckout: boolean,
  unusable?: ReadonlySet<string>,
): BillingCheckout {
  const methods = paymentMethods(info, desktopCheckout, unusable);
  return {
    methods,
    plans: methods.length ? info.plans : [],
    balance:
      info.balanceDisabled || !methods.length
        ? null
        : {
            multiplier:
              info.balanceRechargeMultiplier > 0
                ? info.balanceRechargeMultiplier
                : 1,
            min: info.globalMin,
            max: info.globalMax,
          },
    feeRate: Math.max(0, info.rechargeFeeRate),
    usdToCny: Math.max(0, info.subscriptionUsdToCnyRate),
    helpText: info.helpText,
  };
}

// ---------------------------------------------------------------------------
// Paying a created order

export type PaymentLaunch =
  /** Open this https page (the provider's) in the system browser. */
  | { kind: "open"; url: string }
  /** Show this as a QR code in the app. */
  | { kind: "qr"; qrCode: string }
  /** Ask the service for a /desktop-pay token, then open that page. */
  | { kind: "checkout"; request: CheckoutLinkRequest }
  /** The desktop app cannot pay this order; `method` is then hidden for the session. */
  | { kind: "unavailable"; message: string; hideMethod: boolean };

/**
 * How the desktop app pays an order the service just created (design 4.5):
 * a client secret goes to the service's checkout page (never into a URL);
 * WeChat's in-app flows cannot run here; a QR code is shown in the app;
 * any other page opens in the system browser only over https.
 */
export function paymentLaunch(
  order: CreatedOrder,
  desktopCheckout: boolean,
): PaymentLaunch {
  if (order.clientSecret) {
    if (!desktopCheckout || !order.resumeToken)
      return {
        kind: "unavailable",
        message:
          "This payment method can't be used from the desktop app on this service.",
        hideMethod: true,
      };
    return {
      kind: "checkout",
      request: {
        orderId: order.orderId,
        resumeToken: order.resumeToken,
        clientSecret: order.clientSecret,
        intentId: order.intentId,
        currency: order.currency,
        countryCode: order.countryCode,
        paymentEnv: order.paymentEnv,
      },
    };
  }
  if (
    order.resultType === "oauth_required" ||
    order.resultType === "jsapi_ready"
  )
    return {
      kind: "unavailable",
      message: "WeChat Pay needs the WeChat app and can't be used here.",
      hideMethod: true,
    };
  const mode = order.paymentMode.trim().toLowerCase();
  const redirect = mode === "redirect" || mode === "popup";
  if (order.qrCode && !(redirect && order.payUrl))
    return { kind: "qr", qrCode: order.qrCode };
  if (order.payUrl) {
    const url = httpsUrl(order.payUrl, 4000);
    return url
      ? { kind: "open", url }
      : {
          kind: "unavailable",
          message:
            "The service sent a payment page that isn't secure (https), so it wasn't opened.",
          hideMethod: false,
        };
  }
  return {
    kind: "unavailable",
    message: "The service didn't say how to pay this order.",
    hideMethod: false,
  };
}

// ---------------------------------------------------------------------------
// Following an order

export const orderPollMs = 3_000;

/** Polls after the order's expiry, so a late payment is still seen. */
const pollsAfterExpiry = 2;

export interface OrderWatcherOptions {
  read(orderId: number): Promise<BillingOrder>;
  /** Each status change (and the first status read). */
  onStatus(order: BillingOrder): void;
  /** The order completed: the plan or balance changed. */
  onCompleted(order: BillingOrder): void | Promise<void>;
  /** False once the account that placed the order is gone. */
  active?(): boolean;
  now?(): number;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
  intervalMs?: number;
}

/**
 * Reads each order this session placed every 3 s until it settles
 * (completed, expired, cancelled, failed, refunded) or, past its expiry,
 * two more reads found it still open.
 */
export class OrderWatcher {
  private watched = new Map<
    number,
    { timer?: unknown; status?: string; expiresAt: number | null; late: number }
  >();
  constructor(private options: OrderWatcherOptions) {}
  private get now() {
    return this.options.now?.() ?? Date.now();
  }
  watching(orderId: number) {
    return this.watched.has(orderId);
  }
  watch(orderId: number, expiresAt: number | null) {
    if (this.watched.has(orderId)) return;
    this.watched.set(orderId, { expiresAt, late: 0 });
    this.schedule(orderId);
  }
  stop(orderId: number) {
    const entry = this.watched.get(orderId);
    if (entry?.timer !== undefined)
      (this.options.clearTimer ?? clearTimeout)(
        entry.timer as ReturnType<typeof setTimeout>,
      );
    this.watched.delete(orderId);
  }
  stopAll() {
    for (const orderId of [...this.watched.keys()]) this.stop(orderId);
  }
  private schedule(orderId: number) {
    const entry = this.watched.get(orderId);
    if (!entry) return;
    const set = this.options.setTimer ?? setTimeout;
    entry.timer = set(
      () => void this.poll(orderId),
      this.options.intervalMs ?? orderPollMs,
    );
  }
  /** One read; exposed for tests and for a status the window asks about. */
  async poll(orderId: number) {
    const entry = this.watched.get(orderId);
    if (!entry) return;
    entry.timer = undefined;
    if (this.options.active && !this.options.active()) {
      this.stopAll();
      return;
    }
    let order: BillingOrder | undefined;
    try {
      order = await this.options.read(orderId);
    } catch {
      // A failed read (offline, a 5xx) is tried again at the next tick.
    }
    if (!this.watched.has(orderId)) return;
    if (order) {
      if (order.expiresAt) entry.expiresAt = order.expiresAt;
      const changed = order.status !== entry.status;
      entry.status = order.status;
      if (!orderIsOpen(order.status)) {
        this.stop(orderId);
        // The plan is read again before the window hears of the completion,
        // so the Billing page it reloads shows the new plan.
        if (order.status === "COMPLETED")
          await Promise.resolve(this.options.onCompleted(order)).catch(
            () => {},
          );
        if (changed) this.options.onStatus(order);
        return;
      }
      if (changed) this.options.onStatus(order);
    }
    if (entry.expiresAt !== null && this.now >= entry.expiresAt) {
      entry.late++;
      if (entry.late > pollsAfterExpiry) {
        this.stop(orderId);
        return;
      }
    }
    this.schedule(orderId);
  }
}

// ---------------------------------------------------------------------------
// One signed-in account

/** What Billing needs of the signed-in account (a `RemoteHost` in the app). */
export interface BillingHost {
  readonly backend: {
    readonly session: {
      authorized<T>(call: (accessToken: string) => Promise<T>): Promise<T>;
    };
    readonly client: Pick<Sub2ApiClient, "profile" | "subscriptions">;
    readonly plan?: PlanChoice;
  };
  readonly accounts: { readonly baseUrl: string };
  refreshPlan(): Promise<void>;
}

/** The features the service offers, as far as payments are concerned. */
export type PaymentFeatures = Pick<
  ClaudexFeatures,
  "payment" | "desktopCheckout" | "redeem"
>;

/**
 * The bootstrap source of the signed-in account when package C2 provides
 * one on the host (`host.bootstrap`); until then Billing reads the
 * bootstrap's features itself.
 */
export function bootstrapOf(host: object): BootstrapSource | undefined {
  const source = (host as { bootstrap?: Partial<BootstrapSource> }).bootstrap;
  return source && typeof source.current === "function"
    ? (source as BootstrapSource)
    : undefined;
}

export const redeemErrors: Record<string, string> = {
  REDEEM_CODE_NOT_FOUND: "That code doesn't exist. Check it and try again.",
  REDEEM_CODE_USED: "That code has already been used.",
  REDEEM_CODE_EXPIRED: "That code has expired.",
  REDEEM_CODE_LOCKED: "That code is being redeemed. Try again in a moment.",
  REDEEM_RATE_LIMITED:
    "Too many attempts with codes that didn't work. Try again later.",
};

export const paymentErrors: Record<string, string> = {
  PAYMENT_DISABLED: "Payments are turned off on this service.",
  TOO_MANY_PENDING:
    "You have too many unpaid orders. Pay or cancel one of them first.",
  DAILY_LIMIT_EXCEEDED: "This payment method's daily limit has been reached.",
  INVALID_AMOUNT: "Enter an amount this payment method accepts.",
  PLAN_NOT_AVAILABLE: "This plan is no longer for sale.",
  GROUP_NOT_FOUND: "This plan is no longer available.",
  BALANCE_PAYMENT_DISABLED: "Adding funds is turned off on this service.",
  NO_AVAILABLE_INSTANCE:
    "This payment method isn't available right now. Try another one.",
  PAYMENT_GATEWAY_ERROR:
    "This payment method isn't available right now. Try another one.",
  PAYMENT_PROVIDER_MISCONFIGURED:
    "This payment method isn't available right now. Try another one.",
  PAYMENT_TYPE_UNAVAILABLE: "This payment method isn't available.",
  INVALID_STATUS: "This order can no longer be cancelled.",
  ORDER_NOT_CANCELLABLE: "This order can no longer be cancelled.",
  CANCEL_RATE_LIMITED:
    "You've cancelled several orders recently. Try again later.",
  CLAUDEX_CHECKOUT_UNAVAILABLE: "This order can't be paid in the browser.",
};
