/**
 * The top-up window (checkout.html): Claudex's own checkout, laid out like
 * Stripe Checkout (src/settings/billing/CheckoutPage.tsx), in a window of
 * its own. The official interface's "Buy usage credits" opens it (owner,
 * 2026-10-31: the official purchase panel only takes cards; Claudex is paid
 * with WeChat Pay and Alipay). Settings › Billing opens its other view,
 * Claudex's Billing page (balance, add funds, redeem codes, orders, spend
 * limit; owner, 2026-10-31). Its preload exposes only those calls.
 */
import type {
  BillingCheckout,
  BillingInfo,
  BillingOrder,
  BillingOrderPage,
  PaymentRequest,
  PaymentStarted,
  RedeemResult,
  SpendLimit,
} from "./billing-api";
import type { BillingOrderStatus } from "./billing-api";

export const checkoutWindowChannels = {
  /** invoke(): the page's start-up facts. */
  info: "checkout-window:info",
  /** invoke(method, ...args): one of checkoutWindowMethods. */
  call: "checkout-window:call",
  saveInvoiceCsv: "checkout-window:save-invoice-csv",
  /** send(): close the window. */
  close: "checkout-window:close",
  /** main → page: an order's status changed. */
  order: "checkout-window:order",
  /** main → page: show this view (the window was asked for again). */
  view: "checkout-window:view",
} as const;

/** Add funds (the checkout) or the Billing page. */
export type CheckoutWindowView = "topup" | "billing";

/** The payment calls the page may make (the app's own handlers). */
export const checkoutWindowMethods = [
  "billingInfo",
  "billingOrders",
  "redeemCode",
  "spendLimit",
  "setSpendLimit",
  "billingCheckout",
  "startPayment",
  "reopenPayment",
  "billingOrder",
  "cancelOrder",
] as const;
export type CheckoutWindowMethod = (typeof checkoutWindowMethods)[number];

export interface CheckoutWindowInfo {
  view: CheckoutWindowView;
  email: string;
  theme: "light" | "dark";
  /** The payment methods this window offers (by the service's ids). */
  methods: string[];
}

/** What the window's preload exposes as `window.desktop` (a subset of the app bridge). */
export interface CheckoutDesktopBridge {
  billingInfo(): Promise<BillingInfo | null>;
  billingOrders(page: number): Promise<BillingOrderPage>;
  redeemCode(code: string): Promise<RedeemResult>;
  spendLimit(): Promise<SpendLimit | null>;
  setSpendLimit(limitUsd: number | null): Promise<SpendLimit>;
  billingCheckout(): Promise<BillingCheckout | null>;
  startPayment(request: PaymentRequest): Promise<PaymentStarted>;
  reopenPayment(orderId: number): Promise<void>;
  billingOrder(orderId: number): Promise<BillingOrder>;
  cancelOrder(orderId: number): Promise<BillingOrder>;
  onEvent(
    callback: (event: {
      type: "billing-order";
      orderId: number;
      status: BillingOrderStatus;
    }) => void,
  ): () => void;
}

export interface CheckoutWindowBridge {
  info(): Promise<CheckoutWindowInfo>;
  saveInvoiceCsv(orderId: number, csv: string): Promise<void>;
  close(): void;
  onView(callback: (view: CheckoutWindowView) => void): () => void;
}
