import { currentLocale } from "../../i18n";
/**
 * Prices, fees and dates on Settings → Billing, computed the way the
 * service's own payment page does before an order exists; once an order is
 * created its `payAmount` from the service is shown instead.
 */
import type {
  BillingCheckout,
  BillingOrder,
  PaymentMethod,
  PlanOffer,
} from "../../../shared/billing-api";

const fractionDigits = (currency: string) => {
  try {
    return (
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
};
const round = (value: number, currency: string, up = false) => {
  const factor = 10 ** fractionDigits(currency);
  // The small nudge keeps 20.6 × 100 = 2060.0000000000002 from ceiling to 2061.
  return up
    ? Math.ceil(value * factor - 1e-9) / factor
    : Math.round(value * factor) / factor;
};

/** "$20.00", "CN¥20.60"; a code the platform does not know reads "20.60 XYZ". */
export function money(amount: number, currency: string) {
  const code = currency || "USD";
  try {
    return new Intl.NumberFormat(currentLocale(), {
      style: "currency",
      currency: code,
    }).format(amount);
  } catch {
    return `${new Intl.NumberFormat(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)} ${code}`;
  }
}

export const usd = (amount: number) => money(amount, "USD");

export function shortDate(at: number) {
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(at));
}

export function dateTime(at: number) {
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

/** "30 days", "1 month" from a plan's validity. */
export function validityText(
  plan: Pick<PlanOffer, "validityDays" | "validityUnit">,
) {
  const count = plan.validityDays;
  if (!(count > 0)) return "";
  const unit =
    /^(day|week|month|year)s?$/.exec(plan.validityUnit)?.[1] ?? "day";
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

export interface Quote {
  /** Before the fee, in the method's currency. */
  base: number;
  fee: number;
  /** What the person pays. */
  total: number;
  currency: string;
  /** Why this amount cannot be ordered with this method. */
  problem?: string;
}

function withFee(
  base: number,
  currency: string,
  feeRate: number,
): Omit<Quote, "problem"> {
  const fee = feeRate > 0 ? round((base * feeRate) / 100, currency, true) : 0;
  return { base, fee, total: round(base + fee, currency), currency };
}

function limitProblem(
  amount: number,
  method: PaymentMethod,
  overall?: { min: number; max: number },
) {
  const min = Math.max(method.min, overall?.min ?? 0);
  const max = Math.min(
    method.max > 0 ? method.max : Infinity,
    overall && overall.max > 0 ? overall.max : Infinity,
  );
  if (min > 0 && amount < min)
    return `The smallest amount for ${method.label} is ${money(min, method.currency)}.`;
  if (amount > max)
    return `The largest amount for ${method.label} is ${money(max, method.currency)}.`;
  return undefined;
}

/** Adding `amount` to the balance with `method`. */
export function balanceQuote(
  amount: number,
  method: PaymentMethod,
  checkout: BillingCheckout,
): Quote & { credit: number } {
  const valid = Number.isFinite(amount) && amount > 0;
  const base = valid ? round(amount, method.currency) : 0;
  const quote = withFee(base, method.currency, checkout.feeRate);
  return {
    ...quote,
    credit: Math.round(base * (checkout.balance?.multiplier ?? 1) * 100) / 100,
    problem: !valid
      ? "Enter an amount."
      : limitProblem(base, method, checkout.balance ?? undefined),
  };
}

/** A plan's price with `method`: converted to CNY when the service converts plan prices. */
export function planQuote(
  plan: PlanOffer,
  method: PaymentMethod,
  checkout: BillingCheckout,
): Quote {
  const converted =
    checkout.usdToCny > 0 && method.currency === "CNY"
      ? plan.price * checkout.usdToCny
      : plan.price;
  const base = round(converted, method.currency);
  return {
    ...withFee(base, method.currency, checkout.feeRate),
    problem: limitProblem(base, method),
  };
}

const statusLabels: Record<string, string> = {
  PENDING: "Awaiting payment",
  PAID: "Paid",
  RECHARGING: "Processing",
  COMPLETED: "Completed",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
  REFUND_REQUESTED: "Refund requested",
  REFUNDING: "Refunding",
  REFUND_PENDING: "Refunding",
  PARTIALLY_REFUNDED: "Partly refunded",
  REFUNDED: "Refunded",
  REFUND_FAILED: "Refund failed",
};

export function statusLabel(status: string) {
  return (
    statusLabels[status] ??
    status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ")
  );
}

/** "Pro monthly" for a plan order, "Added funds" for a top-up. */
export function orderTitle(order: BillingOrder, plans: readonly PlanOffer[]) {
  if (order.kind === "subscription") {
    const plan = plans.find((item) => item.id === order.planId);
    return plan ? plan.name : "Plan";
  }
  return "Added funds";
}

/** "Expires in 29:41" until the order's payment window closes. */
export function countdown(expiresAt: number | null, now: number) {
  if (!expiresAt) return "";
  const left = Math.max(0, Math.floor((expiresAt - now) / 1000));
  if (!left) return "This order has expired.";
  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, "0");
  return `Expires in ${minutes}:${seconds}`;
}
