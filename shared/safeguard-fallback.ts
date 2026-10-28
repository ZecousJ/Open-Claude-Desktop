import type { Provider } from "./types";

/** Only a safeguard flag permits a retry, never transport, billing or access failures. */
export function safeguardFlagged(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; type?: unknown };
  return [value.code, value.type].some(
    (code) =>
      typeof code === "string" &&
      [
        "content_policy_violation",
        "content_filter",
        "safety_violation",
        "safeguard",
        "model_refusal",
      ].includes(code),
  );
}

export function safeguardFallbackModel(
  provider: Provider,
  used: readonly string[],
) {
  return [...new Set([provider.model, ...provider.models])].find(
    (model) => model && !used.includes(model),
  );
}
