import type { ChatEffort } from "./types";

export const chatEffortLevels: readonly ChatEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export const chatEffortLabels: Record<ChatEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

/** Codex's standard/extended equivalent uses supported reasoning efforts, not a separate tool. */
export function toggledThinkingEffort(
  current: ChatEffort,
  supported: readonly ChatEffort[],
): ChatEffort | undefined {
  if (!supported.includes("low") || supported.length < 2) return;
  return current === "low"
    ? supported.includes("high")
      ? "high"
      : supported.find((effort) => effort !== "low")
    : "low";
}
