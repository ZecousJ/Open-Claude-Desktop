import type { Turn } from "./types";

export function applyUsageHold(
  turn: Turn,
  refusal: { exceeded: boolean; reason?: string; resetsAt?: number },
) {
  if (
    !refusal.exceeded ||
    !["daily", "weekly", "monthly", "session", "model", "key-quota"].includes(
      refusal.reason ?? "",
    )
  )
    return;
  turn.stopReason = "usage_limit";
  turn.usageHold = { resetsAt: refusal.resetsAt ?? null };
}
