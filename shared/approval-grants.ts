/**
 * A Codex approval response that grants beyond the request: the card's
 * "Always allow" (`acceptForSession`), any policy amendment (an object
 * decision), a permissions grant with `scope: "session"`, or a connector
 * tool approval that names a `persist` scope. The
 * administrator can turn these off (`approvalsAlwaysAllow`); the engine then
 * refuses them.
 */
export function sessionWideGrant(result: unknown) {
  const value = result as {
    decision?: unknown;
    scope?: unknown;
    _meta?: { persist?: unknown } | null;
  } | null;
  return (
    // A connector tool approval remembered for the session or for good.
    value?._meta?.persist === "session" ||
    value?._meta?.persist === "always" ||
    value?.decision === "acceptForSession" ||
    // Every object decision (exec-policy or network-policy amendment)
    // outlives the request, so none is allowed when grants are off.
    (typeof value?.decision === "object" && value.decision !== null) ||
    value?.scope === "session"
  );
}
