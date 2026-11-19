/** Account-bound, read-only Claudex facts; never infers a vendor entitlement. */
import type http from "node:http";
import { isOfficialUiUsageSummarySearch } from "../../../shared/official-ui-web";
import type { PlanUsage } from "../../../shared/usage-api";
import { organizationUuid, reply, type AdapterContext } from "./context";

type Source<T> =
  | { state: "available"; data: T }
  | { state: "unavailable" }
  | { state: "error"; message: string };
const kinds = new Set([
  "session",
  "all_models",
  "models",
  "daily",
  "monthly",
  "key",
]);
function object(v: unknown): Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("Invalid source");
  return v as Record<string, any>;
}
function string(v: unknown, max = 1024): string {
  if (typeof v !== "string" || v.length > max || Buffer.byteLength(v) > max)
    throw Error("Invalid string");
  return v;
}
function number(v: unknown, max = Number.MAX_SAFE_INTEGER / 100): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max)
    throw Error("Invalid number");
  return v;
}
// A service balance may represent debt; do not clamp it to zero or hide it.
function balance(v: unknown): number {
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    Math.abs(v) > Number.MAX_SAFE_INTEGER / 100
  )
    throw Error("Invalid balance");
  return v;
}
function date(v: unknown): number {
  const n = number(v, 8640000000000000);
  if (!Number.isSafeInteger(n)) throw Error("Invalid date");
  return n;
}
function bool(v: unknown): boolean {
  if (typeof v !== "boolean") throw Error("Invalid boolean");
  return v;
}
function nullable<T>(v: unknown, check: (v: unknown) => T): T | null {
  return v === null ? null : check(v);
}
function billing(value: unknown) {
  const v = object(value);
  return {
    plan: nullable(v.plan, string),
    planExpiresAt: nullable(v.planExpiresAt, date),
    balanceUsd: balance(v.balance),
  };
}
function plan(value: unknown): PlanUsage {
  const v = object(value);
  if (!Array.isArray(v.windows) || v.windows.length > 256)
    throw Error("Invalid windows");
  const seen = new Set<string>();
  const windows = v.windows.map((raw: unknown) => {
    const w = object(raw);
    const id = string(w.id, 256);
    if (!id || seen.has(id) || !kinds.has(w.kind))
      throw Error("Invalid window identity");
    seen.add(id);
    if (
      w.models !== null &&
      (!Array.isArray(w.models) || w.models.length > 128)
    )
      throw Error("Invalid models");
    return {
      id,
      kind: w.kind,
      label: string(w.label),
      windowSeconds: nullable(w.windowSeconds, number),
      usedUsd: number(w.usedUsd),
      limitUsd: number(w.limitUsd),
      percent: number(w.percent, 100),
      resetsAt: nullable(w.resetsAt, date),
      active: bool(w.active),
      exceeded: bool(w.exceeded),
      models:
        w.models === null ? null : w.models.map((m: unknown) => string(m, 256)),
    };
  });
  const learnMoreUrl = nullable(v.learnMoreUrl, (input) => {
    const text = string(input, 2048),
      url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password)
      throw Error("Invalid help link");
    return text;
  });
  return {
    plan: string(v.plan),
    expiresAt: nullable(v.expiresAt, date),
    windows,
    updatedAt: date(v.updatedAt),
    warnPercent: number(v.warnPercent, 100),
    learnMoreUrl,
    ...(v.balanceUsd === undefined
      ? {}
      : { balanceUsd: nullable(v.balanceUsd, balance) }),
  };
}
function spend(value: unknown) {
  const v = object(value),
    resetsAt = string(v.resetsAt, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(resetsAt) ||
    !Number.isFinite(Date.parse(resetsAt))
  )
    throw Error("Invalid reset");
  return {
    limitUsd: nullable(v.limitUsd, number),
    usedUsd: number(v.usedUsd),
    resetsAt,
  };
}

export async function hostUsageRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
) {
  const match = /^\/api\/organizations\/([^/]+)\/claudex_usage_summary$/.exec(
    p,
  );
  if (!match) return false;
  const owner = ctx.account()?.id;
  if (!owner) return reply(res, { error: "Not signed in" }, 401);
  if (match[1] !== organizationUuid(owner))
    return reply(res, { error: "Organization not found" }, 404);
  if (req.method !== "GET")
    return reply(res, { error: "Read-only endpoint" }, 405, { Allow: "GET" });
  if (!isOfficialUiUsageSummarySearch(url.search))
    return reply(res, { error: "Unsupported query" }, 400);
  const fresh = url.search === "?fresh=1";
  const activation = ctx.sessionIdentity?.();
  const current = () =>
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation &&
    ctx.isCurrent?.() !== false;
  class Stale extends Error {}
  const check = () => {
    if (!current()) throw new Stale();
  };
  async function read<T>(
    method: string,
    validate: (v: unknown) => T,
    message: string,
    ...args: unknown[]
  ): Promise<Source<T>> {
    check();
    try {
      const value = await ctx.call(method, ...args);
      check();
      if (value === null) return { state: "unavailable" };
      const data = validate(value);
      if (Buffer.byteLength(JSON.stringify(data)) > 512 * 1024)
        throw Error("Source too large");
      return { state: "available", data };
    } catch (error) {
      check();
      if (error instanceof Stale) throw error;
      return { state: "error", message };
    }
  }
  try {
    const billingInfo = await read(
      "billingInfo",
      billing,
      "Billing information could not be read.",
    );
    const planUsage = await read(
      "planUsage",
      plan,
      "Plan usage could not be read.",
      fresh,
    );
    const spendLimit = await read(
      "spendLimit",
      spend,
      "Spend limit could not be read.",
    );
    check();
    return reply(res, {
      version: 1,
      account_uuid: owner,
      organization_uuid: organizationUuid(owner),
      observed_at: new Date().toISOString(),
      currency: "USD",
      billing: billingInfo,
      plan_usage: planUsage,
      spend_limit: spendLimit,
      ...(spendLimit.state === "available" &&
      (!ctx.readOnly || ctx.spendLimitMutation)
        ? {
            spend_limit_write: true,
            ...(ctx.spendLimitMutation
              ? {
                  spend_limit_activation_lease:
                    ctx.spendLimitMutation.activationLease,
                }
              : {}),
          }
        : {}),
    });
  } catch {
    return reply(res, { error: "Account activation changed" }, 409);
  }
}
