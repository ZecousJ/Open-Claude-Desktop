/**
 * Settings → Billing: the plan, balance, redeem codes and (package C5) the
 * in-app payments on the service's `/api/v1/payment/*` endpoints.
 * `shared/settings-api.ts` re-exports the older types.
 */
import { bridgeMethods } from "./bridge-methods";

export interface BillingSubscription {
  id: number;
  plan: string;
  status: string;
  expiresAt: number | null;
}

/** A Sub2API account's plan and balance, for Settings → Billing. */
export interface BillingInfo {
  /** The active subscription's plan (group) name, or null on pay-as-you-go. */
  plan: string | null;
  planExpiresAt: number | null;
  /** Remaining balance in US dollars. */
  balance: number;
  subscriptions: BillingSubscription[];
  /** The service takes redeem codes (off in Sub2API's simple mode). */
  redeem?: boolean;
}

/**
 * Below this balance (US dollars) the composer warns that the balance is
 * running low and offers Add funds.
 */
export const lowBalanceUsd = 10;

export interface RedeemResult {
  message: string;
  billing: BillingInfo | null;
}

/**
 * An order's state as the payment service reports it (PENDING, PAID,
 * RECHARGING, COMPLETED, EXPIRED, CANCELLED, FAILED, REFUNDED…). Open so a
 * state the service adds later is still carried through.
 */
export type BillingOrderStatus =
  | "PENDING"
  | "PAID"
  | "RECHARGING"
  | "COMPLETED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED"
  | "REFUNDED"
  | (string & {});

/** Still moving: the order is waiting for payment or being credited. */
export const openOrderStatuses: readonly string[] = [
  "PENDING",
  "PAID",
  "RECHARGING",
];
export const orderIsOpen = (status: string) =>
  openOrderStatuses.includes(status);

/** How a payment method is paid from the desktop app. */
export type PaymentRoute =
  /** Alipay / WeChat Pay: a QR code in the app or the provider's https page. */
  | "direct"
  /** Stripe / Airwallex: the service's /desktop-pay page in the system browser. */
  | "browser";

/** A payment method the desktop app can use, from `checkout-info`. */
export interface PaymentMethod {
  /** The service's visible method: alipay, wxpay, stripe or airwallex. */
  id: string;
  label: string;
  route: PaymentRoute;
  /** What this method charges in (ISO 4217, upper case). */
  currency: string;
  /** Per-order limits in `currency`; 0 means none. */
  min: number;
  max: number;
}

/** A plan for sale (`checkout-info` → `plans[]`). */
export interface PlanOffer {
  id: number;
  name: string;
  description: string;
  groupName: string;
  /** Before conversion and fees. */
  price: number;
  originalPrice: number | null;
  validityDays: number;
  validityUnit: string;
  features: string[];
}

/** What the person can buy, or null when payments are off on the service. */
export interface BillingCheckout {
  methods: PaymentMethod[];
  plans: PlanOffer[];
  /** Adding funds to the balance; null when the service turned it off. */
  balance: {
    /** US dollars credited per unit paid. */
    multiplier: number;
    /** Across all methods; 0 means none. */
    min: number;
    max: number;
  } | null;
  /** Percent added to every order. */
  feeRate: number;
  /** CNY per plan price unit when plans are paid in CNY; 0 when not converted. */
  usdToCny: number;
  /** The administrator's note on the payment page. */
  helpText: string;
}

/** One of the person's orders (`/payment/orders/my`, `/payment/orders/:id`). */
export interface BillingOrder {
  id: number;
  kind: "balance" | "subscription" | (string & {});
  /** For a plan order, the plan's id. */
  planId: number | null;
  /** What was ordered and what is charged, in `currency`. */
  amount: number;
  payAmount: number;
  currency: string;
  method: string;
  status: BillingOrderStatus;
  createdAt: number;
  expiresAt: number | null;
  paidAt: number | null;
  completedAt: number | null;
}

export interface BillingOrderPage {
  items: BillingOrder[];
  page: number;
  pages: number;
  total: number;
}

export interface PaymentRequest {
  method: string;
  /** A plan order; otherwise adding `amount` to the balance. */
  planId?: number;
  amount?: number;
  /** Paid from a phone: WeChat Pay then opens the payment page, not a QR code. */
  mobile?: boolean;
}

/** A created order and how it is being paid. */
export type PaymentStarted =
  | {
      kind: "qr";
      order: BillingOrder;
      /** What the QR code encodes (the provider's payment link). */
      qrCode: string;
    }
  | {
      /** The payment page opened in the system browser. */
      kind: "browser";
      order: BillingOrder;
    };

/**
 * The person's own monthly spend limit (backend internal/claudex/usage
 * spend.go): null limit is "No spend limit"; the month is UTC.
 */
export interface SpendLimit {
  limitUsd: number | null;
  usedUsd: number;
  resetsAt: string;
}

export interface BillingAPI {
  /** null without a Claudex account or a service that has no spend limits. */
  spendLimit(): Promise<SpendLimit | null>;
  /** null removes the limit ("Set to unlimited"). */
  setSpendLimit(limitUsd: number | null): Promise<SpendLimit>;
  /** null for local accounts. */
  billingInfo(): Promise<BillingInfo | null>;
  redeemCode(code: string): Promise<RedeemResult>;
  /** Plans and payment methods; null when the service has payments off. */
  billingCheckout(): Promise<BillingCheckout | null>;
  /** Creates an order and opens its payment; its progress arrives as "billing-order" events. */
  startPayment(request: PaymentRequest): Promise<PaymentStarted>;
  /** Opens a pending order's payment page again (orders started in this session). */
  reopenPayment(orderId: number): Promise<void>;
  billingOrders(page: number): Promise<BillingOrderPage>;
  billingOrder(orderId: number): Promise<BillingOrder>;
  cancelOrder(orderId: number): Promise<BillingOrder>;
}

export const billingMethods = bridgeMethods<BillingAPI>({
  spendLimit: true,
  setSpendLimit: true,
  billingInfo: true,
  redeemCode: true,
  billingCheckout: true,
  startPayment: true,
  reopenPayment: true,
  billingOrders: true,
  billingOrder: true,
  cancelOrder: true,
});
