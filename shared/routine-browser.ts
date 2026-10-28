/** Built-in Browser approvals. These never represent Chrome extension pairing. */
export type RoutineBrowserGrant =
  | { mode: "all-websites"; approvedAt: number }
  | { mode: "domains"; domains: string[]; approvedAt: number };
export type RoutineBrowserState =
  | { status: "unsupported"; message: string }
  | { status: "supported"; readOnly: boolean; grant?: RoutineBrowserGrant };
export interface RoutineBrowserAPI {
  routineBrowserPermissions(
    id: string,
    source?: "local" | "remote",
  ): Promise<RoutineBrowserState>;
  clearRoutineBrowserPermissions(
    id: string,
    source?: "local" | "remote",
  ): Promise<void>;
}
/** Stored data is bounded and exact-origin only; no wildcard/scheme widening. */
export function validRoutineBrowserGrant(
  value: unknown,
): RoutineBrowserGrant | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object")
    throw new Error("Invalid Browser approval.");
  const item = value as RoutineBrowserGrant;
  if (!Number.isFinite(item.approvedAt) || item.approvedAt < 0)
    throw new Error("Invalid Browser approval.");
  if (item.mode === "all-websites")
    return { mode: item.mode, approvedAt: item.approvedAt };
  if (
    item.mode !== "domains" ||
    !Array.isArray(item.domains) ||
    !item.domains.length ||
    item.domains.length > 200
  )
    throw new Error("Invalid Browser approval.");
  const domains = item.domains.map((origin) => {
    if (typeof origin !== "string" || origin.length > 2048)
      throw new Error("Invalid Browser approval.");
    const url = new URL(origin);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.origin !== origin ||
      url.hostname.includes("*") ||
      url.username ||
      url.password
    )
      throw new Error("Invalid Browser approval.");
    return origin;
  });
  if (new Set(domains).size !== domains.length)
    throw new Error("Invalid Browser approval.");
  return { mode: "domains", domains, approvedAt: item.approvedAt };
}
export function isRoutineBrowserState(
  value: unknown,
): value is RoutineBrowserState {
  if (!value || typeof value !== "object") return false;
  const state = value as RoutineBrowserState;
  if (state.status === "unsupported")
    return typeof state.message === "string" && state.message.length > 0;
  if (state.status !== "supported" || typeof state.readOnly !== "boolean")
    return false;
  try {
    validRoutineBrowserGrant(state.grant);
    return true;
  } catch {
    return false;
  }
}
