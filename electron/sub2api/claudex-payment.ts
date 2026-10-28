/**
 * The service's payment API for Settings → Billing (package C5): upstream
 * Sub2API `/api/v1/payment/*` and `/redeem/history`, and the Claudex
 * checkout link (`POST /claudex/payment/checkout-links`, B10) that lets
 * Stripe and Airwallex be paid on the service's `/desktop-pay` page in the
 * system browser. Answers are read field by field; anything unexpected
 * reads as empty rather than breaking the page.
 */
import {
  checkoutLinkBody,
  parseBootstrap,
  parseCheckoutLink,
  type CheckoutLinkRequest,
  type ClaudexCheckoutLink,
  type ClaudexFeatures,
} from "../../shared/claudex-contract";
import type { BillingOrder, BillingOrderPage } from "../../shared/billing-api";
import { requestJson, Sub2ApiError, type Fetch } from "./http";

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const text = (value: unknown, max = 500) =>
  typeof value === "string" ? value.slice(0, max) : "";
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const optionalNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const time = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const id = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
const currency = (value: unknown) => {
  const code = text(value, 8).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "";
};

function malformed(): never {
  throw new Sub2ApiError(
    502,
    "MALFORMED_RESPONSE",
    "The Claudex service sent an unexpected response.",
  );
}

/** `GET /payment/checkout-info` → `methods`: one entry per enabled method. */
export interface WireMethod {
  type: string;
  currency: string;
  feeRate: number;
  singleMin: number;
  singleMax: number;
}
export interface WirePlan {
  id: number;
  name: string;
  description: string;
  groupName: string;
  price: number;
  originalPrice: number | null;
  validityDays: number;
  validityUnit: string;
  features: string[];
}
export interface CheckoutInfo {
  methods: WireMethod[];
  globalMin: number;
  globalMax: number;
  plans: WirePlan[];
  balanceDisabled: boolean;
  balanceRechargeMultiplier: number;
  subscriptionUsdToCnyRate: number;
  rechargeFeeRate: number;
  helpText: string;
}

/** `POST /payment/orders`: what the provider needs to take the payment. */
export interface CreatedOrder {
  orderId: number;
  amount: number;
  payAmount: number;
  status: string;
  paymentType: string;
  resultType: string;
  payUrl: string;
  qrCode: string;
  clientSecret: string;
  intentId: string;
  currency: string;
  countryCode: string;
  paymentEnv: string;
  paymentMode: string;
  resumeToken: string;
  expiresAt: number | null;
}

export interface CreateOrderBody {
  paymentType: string;
  orderType: "balance" | "subscription";
  amount?: number;
  planId?: number;
  returnUrl: string;
  /** From a phone: the service hands WeChat Pay to its payment page. */
  isMobile?: boolean;
}

export function parseCheckoutInfo(value: unknown): CheckoutInfo {
  const data = object(value);
  const methods = Object.entries(object(data.methods)).flatMap(([key, raw]) => {
    const item = object(raw);
    const type = text(item.payment_type, 40) || key.slice(0, 40);
    if (!/^[a-z_]{1,40}$/.test(type)) return [];
    return [
      {
        type,
        currency: currency(item.currency),
        feeRate: number(item.fee_rate),
        singleMin: number(item.single_min),
        singleMax: number(item.single_max),
      },
    ];
  });
  const plans = list(data.plans).flatMap((raw): WirePlan[] => {
    const item = object(raw);
    const planId = id(item.id);
    if (!planId || !(number(item.price) > 0)) return [];
    return [
      {
        id: planId,
        name: text(item.name, 100) || text(item.group_name, 100),
        description: text(item.description, 500),
        groupName: text(item.group_name, 100),
        price: number(item.price),
        originalPrice: optionalNumber(item.original_price),
        validityDays: number(item.validity_days),
        validityUnit: text(item.validity_unit, 20),
        features: list(item.features)
          .map((feature) => text(feature, 200))
          .filter(Boolean)
          .slice(0, 12),
      },
    ];
  });
  return {
    methods,
    globalMin: number(data.global_min),
    globalMax: number(data.global_max),
    plans,
    balanceDisabled: data.balance_disabled === true,
    balanceRechargeMultiplier: number(data.balance_recharge_multiplier),
    subscriptionUsdToCnyRate: number(data.subscription_usd_to_cny_rate),
    rechargeFeeRate: number(data.recharge_fee_rate),
    helpText: text(data.help_text, 1000),
  };
}

export function parseCreatedOrder(value: unknown): CreatedOrder {
  const data = object(value);
  const orderId = id(data.order_id) ?? malformed();
  return {
    orderId,
    amount: number(data.amount),
    payAmount: number(data.pay_amount),
    status: text(data.status, 32) || "PENDING",
    paymentType: text(data.payment_type, 40),
    resultType: text(data.result_type, 40),
    payUrl: text(data.pay_url, 4000),
    qrCode: text(data.qr_code, 4000),
    clientSecret: text(data.client_secret, 512),
    intentId: text(data.intent_id, 256),
    currency: currency(data.currency),
    countryCode: text(data.country_code, 2),
    paymentEnv: text(data.payment_env, 16),
    paymentMode: text(data.payment_mode, 20),
    resumeToken: text(data.resume_token, 4096),
    expiresAt: time(data.expires_at),
  };
}

export function parseOrder(value: unknown): BillingOrder | undefined {
  const data = object(value);
  const orderId = id(data.id);
  if (!orderId) return undefined;
  return {
    id: orderId,
    kind: text(data.order_type, 20) || "balance",
    planId: id(data.plan_id),
    amount: number(data.amount),
    payAmount: number(data.pay_amount) || number(data.amount),
    currency: currency(data.currency),
    method: text(data.payment_type, 40),
    status: text(data.status, 32) || "PENDING",
    createdAt: time(data.created_at) ?? 0,
    expiresAt: time(data.expires_at),
    paidAt: time(data.paid_at),
    completedAt: time(data.completed_at),
  };
}

export function parseOrderPage(value: unknown): BillingOrderPage {
  const data = object(value);
  const page = Math.max(1, Math.floor(number(data.page)) || 1);
  return {
    items: list(data.items).flatMap((item) => parseOrder(item) ?? []),
    page,
    pages: Math.max(page, Math.floor(number(data.pages)) || 1),
    total: Math.max(0, Math.floor(number(data.total))),
  };
}

/** The account's payment API; every call takes the current access token. */
export class ClaudexPayment {
  constructor(
    readonly baseUrl: string,
    private fetchImpl: Fetch = fetch,
  ) {}
  private call(
    token: string,
    route: string,
    init: { method?: string; body?: unknown } = {},
  ) {
    return requestJson(this.fetchImpl, `${this.baseUrl}/api/v1${route}`, {
      ...init,
      token,
    });
  }
  /** Where the provider sends the person after paying (the service's result page). */
  get returnUrl() {
    return `${this.baseUrl}/payment/result`;
  }
  /** The system-browser checkout page for a token from `checkoutLink`. */
  desktopPayUrl(token: string) {
    return `${this.baseUrl}/desktop-pay#t=${encodeURIComponent(token)}`;
  }
  /** `GET /payment/config` → `enabled` (upstream payment_enabled). */
  async enabled(token: string) {
    return object(await this.call(token, "/payment/config")).enabled === true;
  }
  /**
   * The bootstrap's features, for a service that has them; undefined for a
   * plain Sub2API service (or when the bootstrap cannot be read).
   */
  async features(token: string): Promise<ClaudexFeatures | undefined> {
    try {
      return parseBootstrap(await this.call(token, "/claudex/bootstrap"))
        .features;
    } catch {
      return undefined;
    }
  }
  async checkoutInfo(token: string) {
    return parseCheckoutInfo(await this.call(token, "/payment/checkout-info"));
  }
  async createOrder(token: string, body: CreateOrderBody) {
    return parseCreatedOrder(
      await this.call(token, "/payment/orders", {
        method: "POST",
        body: {
          payment_type: body.paymentType,
          order_type: body.orderType,
          ...(body.orderType === "subscription"
            ? { plan_id: body.planId }
            : { amount: body.amount }),
          return_url: body.returnUrl,
          payment_source: "hosted_redirect",
          is_mobile: body.isMobile ?? false,
        },
      }),
    );
  }
  async order(token: string, orderId: number) {
    return (
      parseOrder(await this.call(token, `/payment/orders/${orderId}`)) ??
      malformed()
    );
  }
  async orders(token: string, page: number, pageSize = 10) {
    return parseOrderPage(
      await this.call(
        token,
        `/payment/orders/my?page=${page}&page_size=${pageSize}`,
      ),
    );
  }
  async cancel(token: string, orderId: number) {
    await this.call(token, `/payment/orders/${orderId}/cancel`, {
      method: "POST",
    });
  }
  /** B10: a one-time token for `/desktop-pay`; the client secret travels in this body only. */
  async checkoutLink(
    token: string,
    request: CheckoutLinkRequest,
  ): Promise<ClaudexCheckoutLink> {
    return parseCheckoutLink(
      await this.call(token, "/claudex/payment/checkout-links", {
        method: "POST",
        body: checkoutLinkBody(request),
      }),
    );
  }
}
