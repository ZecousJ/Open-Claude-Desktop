/**
 * The usage report's figures, from what Claudex knows: the plan's windows, the
 * service's record of the session's requests by model
 * (shared/usage-stats-api.ts `sessionUsage`), Codex's own token totals when the
 * service has none, and the transcript (active time, lines). A figure Claudex
 * does not have is left out, never shown as zero. Pure, so the wording is unit
 * tested.
 */
import type { Conversation, Turn } from "../../shared/types";
import type { TokenUsageBreakdown } from "../../shared/agent-api";
import type { PlanUsageWindow } from "../../shared/usage-api";
import type { SessionUsage } from "../../shared/usage-stats-api";
import { windowPercent, tokenCount } from "../composer/usage-meter";

export interface ReportTokens {
  input: number;
  output: number;
  cacheRead: number;
  /** Null where it is not known (Codex's own totals). */
  cacheWrite: number | null;
}

/** One column of the Breakdown: a model, or the session's total. */
export interface ReportColumn extends ReportTokens {
  /** The model id; "" for Codex's totals, which are not kept by model. */
  model: string;
  /** What the column is headed. */
  label: string;
  /** What the balance was charged for it; null without the service's record. */
  cost: number | null;
}

/** The service's record of the session: what it cost and how long it took. */
export interface ReportResult {
  cost: number;
  apiMs: number;
  /** The turns' time from prompt to last activity; null when not known. */
  wallMs: number | null;
  lines: { added: number; removed: number } | null;
}

export interface ReportSession {
  /** Largest first. */
  columns: ReportColumn[];
  totals: ReportTokens;
  /** A Total column after the models (two or three models, as the live report). */
  showTotal: boolean;
  /** The service's record; null for Codex's totals. */
  result: ReportResult | null;
}

/**
 * The Codex threads that are this session's: its thread, the one its last
 * rewind set aside, and those of its saved reply versions.
 */
export function sessionThreadIds(
  conversation: Pick<Conversation, "threadId" | "rewind" | "savedBranches">,
) {
  const ids = [
    conversation.threadId,
    conversation.rewind?.threadId,
    ...(conversation.savedBranches ?? []).map((branch) => branch.threadId),
  ];
  return [
    ...new Set(
      ids.filter((id): id is string => typeof id === "string" && !!id),
    ),
  ];
}

/**
 * The time the session's finished turns took, from the prompt to the last
 * thing that happened in each (items carry when they started and finished).
 * Null when no turn says.
 */
export function activeMs(
  turns: Pick<Turn, "createdAt" | "status" | "items">[],
) {
  let total = 0;
  for (const turn of turns) {
    if (turn.status === "inProgress") continue;
    let end = 0;
    for (const item of turn.items) {
      const at = Math.max(
        typeof item.completedAt === "number" ? item.completedAt : 0,
        typeof item.startedAt === "number" ? item.startedAt : 0,
      );
      if (at > end) end = at;
    }
    if (end > turn.createdAt) total += end - turn.createdAt;
  }
  return total > 0 ? total : null;
}

const sum = (a: ReportTokens, b: ReportTokens): ReportTokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite:
    a.cacheWrite === null || b.cacheWrite === null
      ? null
      : a.cacheWrite + b.cacheWrite,
});
const tokensOf = (c: ReportTokens) =>
  c.input + c.output + c.cacheRead + (c.cacheWrite ?? 0);

/**
 * The report's session part: the service's record by model when it has the
 * session's requests, else Codex's thread totals in one Total column (no
 * cache writes: Codex does not report them). Null before anything was used.
 */
export function reportSession({
  service,
  codexTotal,
  label,
  wallMs = null,
  lines = null,
}: {
  service: SessionUsage | null | undefined;
  codexTotal: TokenUsageBreakdown | undefined;
  label: (model: string) => string;
  wallMs?: number | null;
  lines?: { added: number; removed: number } | null;
}): ReportSession | null {
  const recorded = (service?.models ?? []).filter(
    (m) =>
      m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens >
        0 || m.cost > 0,
  );
  if (recorded.length) {
    const columns = recorded
      .map((m): ReportColumn => ({
        model: m.model,
        label: label(m.model),
        input: m.inputTokens,
        output: m.outputTokens,
        cacheRead: m.cacheReadTokens,
        cacheWrite: m.cacheWriteTokens,
        cost: m.cost,
      }))
      .sort((a, b) => tokensOf(b) - tokensOf(a));
    return {
      columns,
      totals: columns.reduce(sum, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
      showTotal: columns.length >= 2 && columns.length <= 3,
      result: {
        cost: recorded.reduce((total, m) => total + m.cost, 0),
        apiMs: recorded.reduce((total, m) => total + m.durationMs, 0),
        wallMs,
        lines,
      },
    };
  }
  if (!codexTotal || codexTotal.totalTokens <= 0) return null;
  const cached = Math.min(codexTotal.cachedInputTokens, codexTotal.inputTokens);
  const totals: ReportTokens = {
    input: codexTotal.inputTokens - cached,
    output: codexTotal.outputTokens,
    cacheRead: cached,
    cacheWrite: null,
  };
  return {
    columns: [{ model: "", label: "Total", cost: null, ...totals }],
    totals,
    showTotal: false,
    result: null,
  };
}

/** The live report's model families: Opus, Sonnet, Haiku, else the model's name. */
export function modelFamily(model: string, label: string) {
  const id = model.toLowerCase();
  return id.includes("opus")
    ? "Opus"
    : id.includes("sonnet")
      ? "Sonnet"
      : id.includes("haiku")
        ? "Haiku"
        : label;
}

export type StatCell =
  | { key: "cost"; value: number }
  | { key: "api" | "active"; ms: number }
  | { key: "lines"; added: number; removed: number }
  | { key: string; label: string; pct: number };

/**
 * The cells over the Breakdown, three to a row as the live report lays them:
 * with the service's record Cost, API and Active time and Lines changed,
 * then each family's share of the cost; and the share of input read from
 * the cache. (The live Web searches cell has no Claudex count.)
 */
export function statCells(session: ReportSession, cacheHit: string) {
  const cells: StatCell[] = [];
  const result = session.result;
  if (result) {
    cells.push({ key: "cost", value: result.cost });
    if (result.apiMs > 0) cells.push({ key: "api", ms: result.apiMs });
    if (result.wallMs && result.wallMs > 0)
      cells.push({ key: "active", ms: result.wallMs });
    if (result.lines && (result.lines.added > 0 || result.lines.removed > 0))
      cells.push({ key: "lines", ...result.lines });
    const families = new Map<string, number>();
    let cost = 0;
    for (const column of session.columns) {
      if (!column.cost) continue;
      const family = modelFamily(column.model, column.label);
      families.set(family, (families.get(family) ?? 0) + column.cost);
      cost += column.cost;
    }
    if (cost > 0)
      for (const [family, value] of [...families].sort((a, b) => b[1] - a[1]))
        cells.push({
          key: `family-${family}`,
          label: family,
          pct: Math.round((value / cost) * 100),
        });
  }
  const { input, cacheRead, cacheWrite } = session.totals;
  const read = input + cacheRead + (cacheWrite ?? 0);
  if (read > 0)
    cells.push({
      key: "cache-hit",
      label: cacheHit,
      pct: Math.round((cacheRead / read) * 100),
    });
  const rows: StatCell[][] = [];
  for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3));
  return rows;
}

/** A duration as the live report's cells write it: "42s", "3m 5s", "1h 12m". */
export function shortDuration(ms: number, locale?: string) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const parts: [number, "hour" | "minute" | "second"][] =
    seconds >= 3600
      ? [
          [Math.floor(seconds / 3600), "hour"],
          [Math.floor(seconds / 60) % 60, "minute"],
        ]
      : seconds >= 60
        ? [
            [Math.floor(seconds / 60), "minute"],
            [seconds % 60, "second"],
          ]
        : [[seconds, "second"]];
  return parts
    .filter(([value], index) => index === 0 || value > 0)
    .map(([value, unit]) =>
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "narrow",
      }).format(value),
    )
    .join(" ");
}

/**
 * The text Copy report puts on the clipboard, in the live report's format
 * (Claudex for Claude Code): the plan's limits, then the session's tokens
 * by model with cost and times. Lines Claudex has no figure for are left
 * out (the live "Local activity" line counts another app's local logs).
 */
export function copyReportText({
  generatedAt,
  userAgent,
  windows,
  planError,
  session,
}: {
  generatedAt: Date;
  userAgent: string;
  windows: PlanUsageWindow[];
  planError: boolean;
  session: ReportSession | null;
}) {
  const lines = [
    `Claudex usage report (${generatedAt.toISOString()})`,
    `Client: ${userAgent}`,
    "",
    "Plan limits:",
  ];
  if (planError) lines.push("- unavailable (limits fetch failed)");
  else if (!windows.length) lines.push("- none reported");
  else
    for (const window of windows) {
      const reset =
        window.resetsAt === null
          ? ""
          : ` (resets ${new Date(window.resetsAt).toISOString()})`;
      lines.push(
        `- ${window.label}: ${Math.round(windowPercent(window))}%${reset}`,
      );
    }
  if (session) {
    lines.push("", "Session:");
    for (const column of session.columns)
      lines.push(
        `- ${column.label}: ${tokenCount(column.input)} in / ${tokenCount(column.output)} out / ${tokenCount(column.cacheRead)} cache read` +
          (column.cacheWrite === null
            ? ""
            : ` / ${tokenCount(column.cacheWrite)} cache write`),
      );
    const result = session.result;
    if (result) {
      const minutes = (ms: number) => `${Math.round(ms / 60_000)}m`;
      lines.push(
        `- Cost: $${result.cost.toFixed(2)} | API ${minutes(result.apiMs)}` +
          (result.wallMs === null ? "" : ` | Wall ${minutes(result.wallMs)}`),
      );
    }
  }
  return lines.join("\n");
}
