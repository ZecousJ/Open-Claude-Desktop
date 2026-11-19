import type { UsageWindow } from "./client";
import { validReportedReset } from "./reported-reset";
import { malformed } from "./client-support";
/** Missing/null means no reported window. A present malformed window is an error,
 * never a disabled/unlimited window or synthetic zero. */
export function parseUsageWindowRead(value: unknown): UsageWindow | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed();
  const data = value as Record<string, unknown>;
  const amount = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (
    !amount(data.limit_usd) ||
    !amount(data.used_usd) ||
    !amount(data.percentage) ||
    !validReportedReset(data.resets_at)
  )
    malformed();
  return {
    limitUsd: data.limit_usd,
    usedUsd: data.used_usd,
    // Retain the existing percentage display cap for explicitly reported overage.
    percentage: Math.min(100, data.percentage),
    resetsAt: Date.parse(data.resets_at),
  };
}
