import { Check } from "../ui/glyphs";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "../../shared/types";
import type { PlanUsageWindow } from "../../shared/usage-api";
import type { SessionUsage } from "../../shared/usage-stats-api";
import { AppContext } from "../app/AppContext";
import { conversationTurnChanges } from "../changes/turn-changes";
import { modelLabel } from "../composer/model/code-model-choices";
import {
  resetIn,
  tokenCount,
  usageSeverity,
  windowPercent,
  type PlanUsageState,
} from "../composer/usage-meter";
import { useModelCatalog } from "../composer/useComposerServices";
import { useConversationServices } from "../conversation/ConversationServices";
import { currentLocale, t, useT } from "../i18n";
import { rowLabel } from "../settings/planUsageFormat";
import { AppIcon } from "../ui/app-icon";
import {
  activeMs,
  copyReportText,
  reportSession,
  sessionThreadIds,
  shortDuration,
  statCells,
  type ReportSession,
  type StatCell,
} from "./report-model";
import "./usage-report-card.css";

/**
 * The usage report a Code session posts in its transcript: "Usage" with Copy
 * report over the plan's limits, then "This session": Cost, API and Active
 * time, Lines, each model family's share of the cost and the cache hit rate,
 * three to a row, and the Breakdown of Input / Output / Cache read / Cache
 * write by model. It reads the plan and the service's record of the session
 * when it appears and again when a turn ends, and Codex's own totals until the
 * service has any.
 *
 * Not built, with reasons: the live "Web searches" cell (no Claudex count), the
 * "Costs may be inaccurate…" note (the service's cost is what the balance was
 * charged), credit rows (no subscriptions or credits), and "What's using your
 * limits?" (the live app attributes requests to subagents, skills and MCP
 * servers from its own logs; neither Codex nor the service records that).
 */
export function UsageReportCard({
  conversation,
  posted,
}: {
  conversation: Conversation;
  /** When it was posted: a fresh one scrolls into view. */
  posted: number;
}) {
  useT();
  const app = useContext(AppContext);
  const remote = Boolean(app?.remoteAccount);
  const catalog = useModelCatalog();
  const [plan, setPlan] = useState<PlanUsageState>();
  const [service, setService] = useState<SessionUsage | null>();
  const [attempt, setAttempt] = useState(0);
  const last = conversation.turns.at(-1);
  // A turn that ends may have used more: read again then.
  const settled = `${conversation.turns.length}:${last?.status ?? ""}`;
  const threads = sessionThreadIds(conversation).join("\n");
  useEffect(() => {
    if (!remote) return;
    let live = true;
    setPlan((value) =>
      value?.status === "ready" ? value : { status: "loading" },
    );
    window.desktop
      .planUsage(false)
      .then((usage) => live && setPlan({ status: "ready", usage }))
      .catch(
        () =>
          live &&
          setPlan((value) =>
            value?.status === "ready" ? value : { status: "error" },
          ),
      );
    return () => {
      live = false;
    };
  }, [remote, settled, attempt]);
  useEffect(() => {
    if (!remote || !threads) return;
    let live = true;
    window.desktop
      .sessionUsage({
        sessionIds: threads.split("\n"),
        since: conversation.createdAt,
      })
      .then((value) => live && setService(value))
      // Without the service's record the report keeps Codex's totals.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [remote, threads, settled, conversation.createdAt]);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (Date.now() - posted < 2000)
      ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [posted]);

  const session = useMemo(() => {
    const lines = conversationTurnChanges(conversation).reduce(
      (total, turn) => ({
        added: total.added + turn.additions,
        removed: total.removed + turn.deletions,
      }),
      { added: 0, removed: 0 },
    );
    return reportSession({
      service,
      codexTotal: conversation.tokenUsage?.total,
      label: (model) => modelLabel(catalog, model),
      wallMs: activeMs(conversation.turns),
      lines,
    });
  }, [conversation, service, catalog]);

  const windows =
    plan?.status === "ready" && plan.usage ? plan.usage.windows : [];
  const loading = plan?.status === "loading";
  const failed = plan?.status === "error";
  const planShown = loading || failed || windows.length > 0;
  return (
    <div
      ref={ref}
      className="usage-card"
      role="group"
      aria-label={t("Usage")}
      tabIndex={-1}
    >
      {planShown && (
        <div className="usage-card-plan">
          <span className="usage-card-head">
            <span>Usage</span>
            {!(loading && !windows.length) && (
              <CopyReport
                text={() =>
                  copyReportText({
                    generatedAt: new Date(),
                    userAgent: navigator.userAgent,
                    windows,
                    planError: failed,
                    session,
                  })
                }
              />
            )}
          </span>
          {loading && !windows.length ? (
            <span className="usage-card-muted">Loading usage…</span>
          ) : (
            <>
              {failed && (
                <div className="usage-card-failed">
                  <span>Couldn’t load usage limits</span>
                  <button
                    type="button"
                    className="usage-card-retry"
                    onClick={() => setAttempt((n) => n + 1)}
                  >
                    Retry
                  </button>
                </div>
              )}
              {windows.map((window) => (
                <PlanRow key={window.id} window={window} />
              ))}
            </>
          )}
        </div>
      )}
      {session && <SessionPart session={session} />}
      {!planShown && !session && (
        <span className="usage-card-muted">
          No usage data yet — plan usage appears once limits load, and session
          usage after Claudex’s first reply
        </span>
      )}
    </div>
  );
}

/** The live report's Copy report: a ghost icon button that turns into a check. */
function CopyReport({ text }: { text: () => string }) {
  const services = useConversationServices();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const label = copied ? "Copied" : "Copy report";
  return (
    <button
      type="button"
      className="usage-card-icon"
      aria-label={t(label)}
      title={t(label)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() =>
        void services.copyText(text()).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    >
      {copied ? (
        <Check size={16} aria-hidden="true" />
      ) : (
        <AppIcon name="Copy" />
      )}
    </button>
  );
}

const percentText = (value: number) =>
  new Intl.NumberFormat(currentLocale(), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value / 100);

/** A window: its name, then reset time and percent, over an 8px meter. */
function PlanRow({ window }: { window: PlanUsageWindow }) {
  const id = `usage-card-${window.id}`;
  const percent = windowPercent(window);
  const reset = resetIn(window.resetsAt, Date.now());
  const shown = percentText(percent);
  const rounded = Math.round(percent);
  return (
    <div className="usage-card-row">
      <div className="usage-card-line">
        <span id={id} className="usage-card-label" data-no-translate>
          {rowLabel(window)}
        </span>
        <span className="usage-card-value">
          {reset && <span>{reset}</span>}
          <span
            className={
              rounded === 0
                ? undefined
                : `usage-card-percent ${usageSeverity(percent)}`
            }
          >
            {shown}
          </span>
        </span>
      </div>
      <div
        className="usage-card-meter"
        role="progressbar"
        aria-labelledby={id}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
        aria-valuetext={reset ? `${shown} · ${reset}` : shown}
      >
        {percent > 0 && (
          <i
            className={usageSeverity(percent)}
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
    </div>
  );
}

const money = (value: number) =>
  new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: "USD",
  }).format(value);

function StatValue({ cell }: { cell: StatCell }) {
  if ("value" in cell) return <>{money(cell.value)}</>;
  if ("ms" in cell) return <>{shortDuration(cell.ms, currentLocale())}</>;
  if ("added" in cell)
    return (
      <>
        <span className="usage-card-added">{`+${cell.added}`}</span>{" "}
        <span className="usage-card-removed">{`−${cell.removed}`}</span>
      </>
    );
  return <>{percentText(cell.pct)}</>;
}

const statLabels: Record<string, string> = {
  cost: "Cost",
  api: "API",
  active: "Active",
  lines: "Lines",
};

function SessionPart({ session }: { session: ReportSession }) {
  const rows = statCells(session, t("Cache hit"));
  const { columns, totals, showTotal } = session;
  const kinds = [
    { key: "in", label: "Input", pick: (c: typeof totals) => c.input },
    { key: "out", label: "Output", pick: (c: typeof totals) => c.output },
    { key: "cr", label: "Cache read", pick: (c: typeof totals) => c.cacheRead },
    ...(totals.cacheWrite === null
      ? []
      : [
          {
            key: "cw",
            label: "Cache write",
            pick: (c: typeof totals) => c.cacheWrite ?? 0,
          },
        ]),
  ];
  const costs =
    columns.length > 1 && columns.some((column) => (column.cost ?? 0) > 0);
  const totalCost = columns.reduce((sum, c) => sum + (c.cost ?? 0), 0);
  return (
    <div className="usage-card-session">
      <div className="usage-card-stats">
        <span className="usage-card-title">This session</span>
        {rows.length > 0 && (
          <div className="usage-card-stat-rows">
            {rows.map((row, index) => (
              <div key={index} className="usage-card-stat-row">
                {row.map((cell) => (
                  <span key={cell.key} className="usage-card-stat">
                    <span
                      className="usage-card-stat-label"
                      data-no-translate={"label" in cell ? true : undefined}
                    >
                      {"label" in cell ? cell.label : statLabels[cell.key]}
                    </span>
                    <span className="usage-card-stat-value">
                      <StatValue cell={cell} />
                    </span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div
        className="usage-card-grid"
        style={{
          gridTemplateColumns: `max-content repeat(${columns.length + (showTotal ? 1 : 0)}, minmax(0, 1fr))`,
        }}
      >
        <span className="usage-card-title usage-card-grid-head">Breakdown</span>
        {columns.map((column) => (
          <span
            key={column.model || "total"}
            className="usage-card-cell usage-card-grid-head usage-card-model"
            data-no-translate={column.model ? true : undefined}
          >
            {column.label}
          </span>
        ))}
        {showTotal && (
          <span className="usage-card-cell usage-card-grid-head">Total</span>
        )}
        <span className="usage-card-rule" aria-hidden="true" />
        {kinds.map((kind) => (
          <div key={kind.key} className="usage-card-cells">
            <span>{kind.label}</span>
            {columns.map((column) => (
              <span key={column.model || "total"} className="usage-card-cell">
                {tokenCount(kind.pick(column))}
              </span>
            ))}
            {showTotal && (
              <span className="usage-card-cell">
                {tokenCount(kind.pick(totals))}
              </span>
            )}
            <span className="usage-card-rule" aria-hidden="true" />
          </div>
        ))}
        {costs && (
          <div className="usage-card-cells">
            <span>Cost</span>
            {columns.map((column) => (
              <span key={column.model} className="usage-card-cell">
                {(column.cost ?? 0) > 0 ? money(column.cost ?? 0) : "–"}
              </span>
            ))}
            {showTotal && (
              <span className="usage-card-cell">{money(totalCost)}</span>
            )}
            <span className="usage-card-rule" aria-hidden="true" />
          </div>
        )}
      </div>
    </div>
  );
}
