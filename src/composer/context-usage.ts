import type { Conversation } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import type { TokenUsageBreakdown } from "../../shared/agent-api";

/** How full the conversation's context is, for the Code footer ring. */
export interface ContextUsage {
  /** Tokens in the context now (the latest request's total). */
  used: number;
  /** The window those tokens fill; null when neither Codex nor the catalog names one. */
  window: number | null;
  /** used / window, 0–1; null without a window. */
  fraction: number | null;
  /** Every request of the session added up, for the popover's usage report. */
  total?: TokenUsageBreakdown;
  /** No session yet: the composer starts one. */
  draft?: boolean;
}

/**
 * The context the latest request used (`tokenUsage.last.totalTokens`; the
 * thread's total counts every request and only grows) against the window
 * Codex reports, else the catalog's window for the conversation's model.
 * No conversation, or one without token usage yet, uses nothing.
 */
export function contextUsage(
  conversation: Conversation | undefined,
  catalog: ModelCatalog | null | undefined,
  model?: string,
): ContextUsage {
  const usage = conversation?.tokenUsage;
  const used = usage?.last.totalTokens ?? 0;
  const id = conversation?.model ?? model;
  const fromCatalog = catalog?.items.find(
    (item) => item.id === id,
  )?.contextWindow;
  const window =
    usage?.modelContextWindow ??
    (fromCatalog && fromCatalog > 0 ? fromCatalog : null);
  return {
    used,
    window,
    fraction: window ? Math.min(1, Math.max(0, used / window)) : null,
    total: usage?.total,
    draft: !conversation,
  };
}

const compact = (value: number) =>
  value >= 1_000_000
    ? `${+(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${Math.round(value / 1_000)}k`
      : String(value);

/** The ring's tooltip and accessible name. */
export function contextUsageLabel({ used, window, fraction }: ContextUsage) {
  if (window === null || fraction === null)
    return `${used.toLocaleString("en-US")} tokens in context`;
  const percent = Math.round(fraction * 100);
  return `${percent}% of context used (${compact(used)} of ${compact(window)} tokens)`;
}

/** The popover's summary: "25% used · 65k of 258k tokens", or the bare count. */
export function contextSummary({ used, window, fraction }: ContextUsage) {
  if (window === null || fraction === null)
    return `${used.toLocaleString("en-US")} tokens`;
  return `${Math.round(fraction * 100)}% used · ${compact(used)} of ${compact(window)}`;
}
