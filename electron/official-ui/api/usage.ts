/**
 * Settings › Usage for a Claudex account, which pays from its balance (owner,
 * 2026-10-12: no subscriptions, balance only).
 *
 * `GET …/usage` (c71860c77 Ha): `limits` is the list of plan-limit cards; an
 * account without plan windows answers [] so the page shows no limit cards
 * (null would read "Unable to load usage limits"). Windows the Claudex
 * service does report (a plan's session, weekly or per-model rules) become
 * cards. The legacy objects (five_hour, seven_day, …) feed the composer's
 * limit notices; utilization is a whole percent, as recorded (18.0, 49.0).
 *
 * The page's "Usage credits" section is the balance (shared-0 o6
 * `/prepaid/credits`: `amount` in cents) and its monthly spend limit
 * (`/overage_spend_limit`, c4fd407cc: `monthly_credit_limit`, `used_credits`
 * in cents), on Claudex's "billingInfo", "spendLimit" and "setSpendLimit".
 */
import type http from "node:http";
import type { PlanUsage, PlanUsageWindow } from "../../../shared/usage-api";
import type { BillingInfo, SpendLimit } from "../../../shared/billing-api";
import {
  empty,
  readJson,
  reply,
  organizationUuid,
  type AdapterContext,
} from "./context";

function windowOf(window: PlanUsageWindow | undefined) {
  if (!window) return null;
  return {
    utilization: Math.max(0, Math.min(100, Math.round(window.percent))),
    resets_at: window.resetsAt ? new Date(window.resetsAt).toISOString() : null,
    limit_dollars: window.limitUsd,
    used_dollars: window.usedUsd,
    remaining_dollars: Math.max(0, window.limitUsd - window.usedUsd),
    locked_reason: window.exceeded ? "limit_reached" : null,
  };
}

const severity = (percent: number) =>
  percent >= 100 ? "critical" : percent >= 80 ? "warning" : "normal";
/** The plan-limit cards (c71860c77 hi): session, weekly over all models, weekly per model. */
function limitsOf(plan: PlanUsage | null) {
  return (plan?.windows ?? [])
    .filter(
      (w) =>
        w.kind === "session" || w.kind === "all_models" || w.kind === "models",
    )
    .map((w) => ({
      kind:
        w.kind === "session"
          ? "session"
          : w.kind === "all_models"
            ? "weekly_all"
            : "weekly_scoped",
      group: w.kind === "session" ? "session" : "weekly",
      percent: Math.max(0, Math.min(100, Math.round(w.percent))),
      severity: severity(w.percent),
      resets_at: w.resetsAt ? new Date(w.resetsAt).toISOString() : null,
      is_active: w.active,
      scope:
        w.kind === "models"
          ? { model: { id: w.id, display_name: w.label }, surface: null }
          : null,
    }));
}

const cents = (usd: number) => Math.round(usd * 100);
/** The monthly spend limit as the Usage page reads it (c4fd407cc / c9675fdeb ti). */
export function spendLimitOf(limit: SpendLimit | null) {
  if (limit === null) return null;
  validateLimit(limit);
  return {
    is_enabled: true,
    monthly_credit_limit:
      limit?.limitUsd == null ? null : cents(limit.limitUsd),
    currency: "USD",
    limit_usd: limit.limitUsd,
    used_usd: limit.usedUsd,
    used_credits: cents(limit?.usedUsd ?? 0),
    limit_type: "organization",
    disabled_reason: null,
    user_disabled: false,
    spend_limit_reached:
      limit?.limitUsd != null && limit.usedUsd >= limit.limitUsd,
    resets_at: limit?.resetsAt ?? null,
  };
}

/** The same limit as `/usage` carries it (shared-0 fx: `monthly_limit`, null is no limit). */
function extraUsageOf(limit: SpendLimit | null) {
  const spend = spendLimitOf(limit);
  if (!spend) return null;
  return {
    is_enabled: true,
    user_disabled: false,
    credits_ever_enabled: true,
    monthly_limit: spend.monthly_credit_limit,
    used_credits: spend.used_credits,
    currency: "USD",
    disabled_reason: null,
    spend_limit_reached: spend.spend_limit_reached,
  };
}

export function usageOf(
  plan: PlanUsage | null,
  limit: SpendLimit | null = null,
) {
  if (plan !== null) validatePlan(plan);
  const windows = plan?.windows ?? [];
  const session = windows.find((w) => w.kind === "session");
  const weekly = windows.find(
    (w) => w.kind === "all_models" && (w.windowSeconds ?? 0) >= 6 * 86400,
  );
  const allModels = weekly ?? windows.find((w) => w.kind === "all_models");
  const perModel = windows.filter((w) => w.kind === "models");
  const named = (pattern: RegExp) =>
    windowOf(
      perModel.find((w) => (w.models ?? []).some((m) => pattern.test(m))),
    );
  return {
    five_hour: windowOf(session),
    seven_day: windowOf(allModels),
    seven_day_opus: named(/opus/i),
    seven_day_sonnet: named(/sonnet/i),
    seven_day_oauth_apps: null,
    seven_day_cowork: null,
    limits: limitsOf(plan),
    weekly_scoped_shares: null,
    extra_usage: extraUsageOf(limit),
  };
}

function money(value: unknown) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isSafeInteger(Math.round(value * 100))
  );
}
function validateLimit(value: SpendLimit) {
  if (
    !value ||
    (value.limitUsd !== null && !money(value.limitUsd)) ||
    !money(value.usedUsd) ||
    typeof value.resetsAt !== "string" ||
    !Number.isFinite(Date.parse(value.resetsAt))
  )
    throw Error("Invalid spend limit source");
}
function validatePlan(value: PlanUsage) {
  if (
    !value ||
    !Array.isArray(value.windows) ||
    value.windows.length > 1024 ||
    value.windows.some(
      (w) =>
        !w ||
        !money(w.usedUsd) ||
        !money(w.limitUsd) ||
        !Number.isFinite(w.percent) ||
        w.percent < 0 ||
        (w.resetsAt !== null &&
          !Number.isFinite(new Date(w.resetsAt).getTime())) ||
        typeof w.active !== "boolean" ||
        typeof w.exceeded !== "boolean" ||
        (w.models !== null &&
          (!Array.isArray(w.models) ||
            w.models.some((m) => typeof m !== "string"))),
    )
  )
    throw Error("Invalid plan usage source");
}

export async function usageRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: AdapterContext,
): Promise<boolean> {
  const route =
    /^\/api\/organizations\/([^/]+)\/(usage|prepaid\/credits|overage_spend_limit)$/.exec(
      p,
    );
  const checkout =
    p === "/api/__claudex/checkout" || p === "/api/__claudex/billing";
  if (!route && !checkout) return false;
  const fail = (status: number, message: string) =>
    reply(
      res,
      { type: "error", error: { type: "invalid_request_error", message } },
      status,
    );
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.();
  if (!owner) return fail(401, "Sign in to continue.");
  if (route && route[1] !== organizationUuid(owner))
    return fail(404, "Organization not found.");
  const current = () =>
    ctx.isCurrent?.() !== false &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation;
  const method = req.method ?? "GET";
  if (!current()) return fail(409, "The account changed. Reload billing.");
  try {
    const query = new URL(req.url ?? p, "http://localhost").searchParams;
    if (query.has("cedar_ember") || query.has("at_wall"))
      return fail(
        501,
        "Usage recovery grants are not supported by this account service.",
      );
    if (
      [...query.keys()].some(
        (key) =>
          !["skip_spend", "org_service_name", "channel_id"].includes(key),
      ) ||
      ["org_service_name", "channel_id"].some(
        (key) => query.getAll(key).length > 1 || !!query.get(key),
      ) ||
      (query.has("skip_spend") &&
        (route?.[2] !== "usage" ||
          method !== "GET" ||
          query.getAll("skip_spend").length !== 1 ||
          query.get("skip_spend") !== "1"))
    )
      return fail(501, "This usage query is not supported.");
    const skipSpend = query.get("skip_spend") === "1";
    if (checkout) {
      if (method !== "POST") return fail(405, "Unsupported billing operation.");
      if (ctx.readOnly || !ctx.openCheckout)
        return fail(501, "Billing checkout is not available here.");
      ctx.openCheckout(p.endsWith("/billing") ? "billing" : "topup");
      return empty(res);
    }
    if (method !== "GET" && route![2] !== "overage_spend_limit")
      return fail(405, "Usage information is read-only.");
    const mutation = ctx.spendLimitMutation;
    if (
      method !== "GET" &&
      ctx.readOnly &&
      (!mutation?.save || method !== "PUT")
    )
      return fail(501, "Spend-limit changes are not available here.");
    if (route![2] === "usage") {
      const [plan, limit] = (await Promise.all([
        ctx.call("planUsage", false),
        skipSpend ? Promise.resolve(null) : ctx.call("spendLimit"),
      ])) as [PlanUsage | null, SpendLimit | null];
      if (!current()) return fail(409, "The account changed. Reload billing.");
      // A source error is not an absent plan or an unlimited spend limit.
      return reply(res, usageOf(plan, limit));
    }
    if (route![2] === "prepaid/credits") {
      const info = (await ctx.call("billingInfo")) as BillingInfo | null;
      if (!current()) return fail(409, "The account changed. Reload billing.");
      if (info === null)
        return fail(
          501,
          "Balance information is not available for this account.",
        );
      if (!info || !money(info.balance)) throw Error("Invalid balance source");
      return reply(res, {
        amount: cents(info.balance),
        currency: "USD",
        auto_reload_settings: null,
        tranches: [],
        promo_tranches: [],
        pending_invoice_amount_cents: null,
      });
    }
    if (method === "GET") {
      const limit = (await ctx.call("spendLimit")) as SpendLimit | null;
      if (!current()) return fail(409, "The account changed. Reload billing.");
      if (limit === null)
        return fail(
          501,
          "Spend limits are not supported by this account service.",
        );
      return reply(res, spendLimitOf(limit));
    }
    if (!["POST", "PUT"].includes(method))
      return fail(405, "Unsupported spend-limit operation.");
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return fail(400, "Invalid spend-limit request.");
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !("monthly_credit_limit" in body) ||
      Object.keys(body).some(
        (k) =>
          !(
            ctx.readOnly
              ? ["monthly_credit_limit", "currency", "period"]
              : [
                  "monthly_credit_limit",
                  "currency",
                  "is_enabled",
                  "period",
                  "org_service_name",
                  "default_channel_credit_limit",
                  "channel_id",
                ]
          ).includes(k),
      )
    )
      return fail(400, "Invalid spend-limit request.");
    if (
      ("is_enabled" in body && body.is_enabled !== true) ||
      ("period" in body && body.period !== "monthly") ||
      ("default_channel_credit_limit" in body &&
        body.default_channel_credit_limit != null) ||
      ("channel_id" in body &&
        body.channel_id != null &&
        body.channel_id !== "")
    )
      return fail(
        501,
        "Service or channel-specific spend limits are not supported.",
      );
    if ("org_service_name" in body && body.org_service_name != null)
      return fail(501, "This service-specific spend limit is not supported.");
    if ("currency" in body && body.currency !== "USD")
      return fail(400, "Only USD spend limits are supported.");
    const amount = body.monthly_credit_limit;
    if (
      amount !== null &&
      (typeof amount !== "number" ||
        !Number.isSafeInteger(amount) ||
        amount < 0 ||
        amount > 10_000_000)
    )
      return fail(
        400,
        "The monthly limit must be between $0 and $100,000 in whole cents, or unlimited.",
      );
    if (!current()) return fail(409, "The account changed. Reload billing.");
    const limitUsd = amount === null ? null : amount / 100;
    const saved = mutation?.save
      ? await mutation.save(limitUsd)
      : ((await ctx.call("setSpendLimit", limitUsd)) as SpendLimit);
    if (!saved || saved.limitUsd !== limitUsd)
      throw Error("The saved spend limit could not be confirmed.");
    if (!current()) return fail(409, "The account changed. Reload billing.");
    return reply(res, { ...spendLimitOf(saved), organization_uuid: route![1] });
  } catch {
    return fail(
      current() ? 503 : 409,
      current()
        ? "Usage or billing information is temporarily unavailable."
        : "The account changed. Reload billing.",
    );
  }
}
