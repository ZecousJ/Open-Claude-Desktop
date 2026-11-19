import type { SpendLimit } from "../../shared/billing-api";
import { z } from "zod";
import { requestJson, Sub2ApiError, type Fetch } from "../sub2api/http";
import { validReportedReset } from "../sub2api/reported-reset";

export const spendLimitAmount = z.number().min(0).max(100_000).nullable();

export async function writeSpendLimitSource(input: {
  baseUrl: string;
  fetch?: Fetch;
  token: string;
  limitUsd: number | null;
}): Promise<SpendLimit> {
  const response = await requestJson(
    input.fetch ?? fetch,
    `${input.baseUrl}/api/v1/claudex/spend-limit`,
    {
      method: "PUT",
      token: input.token,
      body: { limit_usd: input.limitUsd },
    },
  );
  if (
    !response ||
    typeof response !== "object" ||
    !("currency" in response) ||
    response.currency !== "USD"
  )
    throw Error("Invalid spend limit response.");
  return parseSpendLimitRead(response);
}

export function parseSpendLimitRead(value: unknown): SpendLimit {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid spend limit response.");
  const v = value as Record<string, unknown>;
  const amount = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (
    !Object.hasOwn(v, "limit_usd") ||
    !(v.limit_usd === null || amount(v.limit_usd)) ||
    !Object.hasOwn(v, "used_usd") ||
    !amount(v.used_usd) ||
    !validReportedReset(v.resets_at)
  )
    throw Error("Invalid spend limit response.");
  return { limitUsd: v.limit_usd, usedUsd: v.used_usd, resetsAt: v.resets_at };
}

/** The read callback must assert immediately before its authorized transport,
 * because obtaining/refreshing a token can yield after this helper's first check. */
export async function readSpendLimitSource(
  read: (assertCurrent: () => void) => Promise<unknown>,
  isCurrent: () => boolean,
): Promise<SpendLimit | null> {
  const check = () => {
    if (!isCurrent())
      throw Error("The account changed while reading its spend limit.");
  };
  check();
  try {
    const value = await read(check);
    check();
    return parseSpendLimitRead(value);
  } catch (error) {
    check();
    // Only an explicit protocol-level unsupported/missing endpoint is absence.
    if (error instanceof Sub2ApiError && [404, 501].includes(error.status))
      return null;
    throw Error("The spend limit could not be read. Please retry.");
  }
}
