/** Monetary profile data must be explicit, unlike optional display counters. */
export function profileBalance(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
