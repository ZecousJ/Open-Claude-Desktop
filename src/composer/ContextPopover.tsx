import { useId } from "react";
import type { PlanUsageWindow } from "../../shared/usage-api";
import { rowLabel } from "../settings/planUsageFormat";
import { currentLocale, formatText, t, useT } from "../i18n";
import { contextSummary, type ContextUsage } from "./context-usage";
import {
  resetIn,
  usageSeverity,
  windowPercent,
  type PlanUsageState,
} from "./usage-meter";
import { AppIcon } from "../ui/app-icon";
import "./context-popover.css";

/**
 * The popover the Code context ring opens, in the live 360px usage panel's
 * frame. The live panel holds only the plan limits; Claudex shows what its
 * accounts have:
 *
 * - in a session, the context window: the summary, a 4px bar and Compact
 *   session (before the first reply, "Send a message to see context usage.");
 * - the balance and what was spent today and over the last 7 days, with a link
 *   to Settings → Usage, and the group's limits, if it has any, as the live
 *   panel's rows with their reset time, percent and meter;
 * - in a session, "See detailed breakdown", which posts the usage report in the
 *   session's transcript (`onShowUsageReport`, src/usage-report).
 *
 * Not built, with reasons: the live context header expands into a per-category
 * card (system prompt, tools, MCP tools, memory files, messages), which Codex
 * does not report.
 */
export function ContextPopover({
  usage,
  onCompact,
  compactReason,
  plan,
  spend,
  onUsageSettings,
  onShowUsageReport,
  now = Date.now(),
}: {
  usage: ContextUsage;
  /** Compacts the open session; left out where there is none to compact. */
  onCompact?: () => void;
  /** Why compaction is not available now, shown left of the button (also its title). */
  compactReason?: string;
  /** The balance and the group's limits; left out without a Claudex account. */
  plan?: PlanUsageState;
  /** What was spent today and over the last 7 days, in US dollars. */
  spend?: SpendState;
  /** Opens Settings → Usage. */
  onUsageSettings?: () => void;
  /**
   * Posts the usage report in the session's transcript (and closes the
   * popover); left out where there is no session.
   */
  onShowUsageReport?: () => void;
  /** The time the reset times count from (tests pass one). */
  now?: number;
}) {
  useT();
  const hintId = useId();
  const windows =
    plan?.status === "ready" && plan.usage ? plan.usage.windows : [];
  const session = !usage.draft;
  const showReport = session ? onShowUsageReport : undefined;
  const empty = usage.used === 0;
  const percent =
    usage.fraction === null ? undefined : Math.round(usage.fraction * 100);
  const summary = contextSummary(usage);
  return (
    <div className="context-popover" role="dialog" aria-label="Usage">
      {session && (
        <>
          <div className="context-popover-head">
            <span>Context window</span>
            {!empty && (
              <span className="context-popover-summary">{summary}</span>
            )}
          </div>
          <div className="context-popover-body">
            {empty ? (
              <p className="context-popover-empty">
                Send a message to see context usage.
              </p>
            ) : (
              <div
                className="context-popover-bar"
                role="progressbar"
                aria-label="Context window"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={percent === undefined ? summary : undefined}
              >
                {percent !== undefined && (
                  <i
                    className={usageSeverity(percent)}
                    style={{ width: `${percent}%` }}
                  />
                )}
              </div>
            )}
          </div>
          {!empty && onCompact && (
            <div className="context-popover-actions">
              {compactReason !== undefined && (
                <span id={hintId} className="context-popover-hint">
                  {compactReason}
                </span>
              )}
              <button
                className="context-popover-compact"
                disabled={compactReason !== undefined}
                title={compactReason}
                aria-describedby={
                  compactReason === undefined ? undefined : hintId
                }
                onClick={onCompact}
              >
                Compact session
              </button>
            </div>
          )}
        </>
      )}
      {plan && (
        <BalanceSection
          plan={plan}
          spend={spend}
          windows={windows}
          now={now}
          ruled={session}
          onUsageSettings={onUsageSettings}
        />
      )}
      {showReport && (
        <>
          <div className="context-popover-rule" />
          <div className="context-popover-row">
            <button
              type="button"
              className="context-popover-compact"
              onClick={showReport}
            >
              See detailed breakdown
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The spend the popover shows, read when it opens. */
export type SpendState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; todayUsd: number; weekUsd: number };

const usd = (value: number) =>
  new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

/**
 * "Balance and usage" with its link to Settings → Usage: the balance, what
 * was spent today and over the last 7 days, then the group's limits as the
 * live panel's rows.
 */
function BalanceSection({
  plan,
  spend,
  windows,
  now,
  ruled,
  onUsageSettings,
}: {
  plan: PlanUsageState;
  spend?: SpendState;
  windows: PlanUsageWindow[];
  now: number;
  ruled: boolean;
  onUsageSettings?: () => void;
}) {
  const balance =
    plan.status === "ready" ? (plan.usage?.balanceUsd ?? null) : undefined;
  const dash = "—";
  const value = (amount: number | null | undefined, loading: boolean) =>
    amount === undefined || amount === null
      ? loading
        ? "…"
        : dash
      : usd(amount);
  const spendLoading = !spend || spend.status === "loading";
  return (
    <>
      {ruled && <div className="context-popover-rule" />}
      <div className="context-popover-head">
        <span>{t("Balance and usage")}</span>
        {onUsageSettings && (
          <button
            type="button"
            className="context-popover-link"
            aria-label="View usage in Settings"
            title="View usage in Settings"
            onClick={onUsageSettings}
          >
            <AppIcon name="ArrowRight" size={12} />
          </button>
        )}
      </div>
      <div className="context-popover-plan">
        <BalanceRow
          label="Balance"
          value={value(balance, plan.status === "loading")}
        />
        <BalanceRow
          label="Today"
          value={value(
            spend?.status === "ready" ? spend.todayUsd : undefined,
            spendLoading,
          )}
        />
        <BalanceRow
          label="Last 7 days"
          value={value(
            spend?.status === "ready" ? spend.weekUsd : undefined,
            spendLoading,
          )}
        />
        {plan.status === "error" && (
          <span>{t("Couldn’t load usage limits")}</span>
        )}
        {windows.map((window) => (
          <PlanRow key={window.id} window={window} now={now} />
        ))}
      </div>
    </>
  );
}

function BalanceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="context-plan-line">
      <span className="context-plan-label">{t(label)}</span>
      <span className="context-plan-value">{value}</span>
    </div>
  );
}

const percentText = (value: number) =>
  new Intl.NumberFormat(currentLocale(), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value / 100);

/** A plan meter: the panel’s 4px bar, or (`tall`) the Usage panel’s 8px one. */
function Meter({
  percent,
  labelledBy,
  valueText,
  tall,
}: {
  percent: number;
  labelledBy: string;
  valueText?: string;
  tall?: boolean;
}) {
  const shown = Math.round(percent);
  return (
    <div
      className={`context-meter${tall ? " tall" : ""}`}
      role="progressbar"
      aria-labelledby={labelledBy}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={shown}
      aria-valuetext={valueText}
    >
      {percent > 0 && (
        <i
          className={usageSeverity(percent)}
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}

export function PlanRow({
  window,
  now,
}: {
  window: PlanUsageWindow;
  now: number;
}) {
  const id = `context-plan-${window.id}`;
  const percent = windowPercent(window);
  const reset = resetIn(window.resetsAt, now);
  return (
    <div className="context-plan-row">
      <div className="context-plan-line">
        <span id={id} className="context-plan-label" data-no-translate>
          {rowLabel(window)}
        </span>
        <span className="context-plan-value">
          {reset && <span>{reset}</span>}
          <span>{`${Math.round(percent)}%`}</span>
        </span>
      </div>
      <Meter percent={percent} labelledBy={id} />
    </div>
  );
}
