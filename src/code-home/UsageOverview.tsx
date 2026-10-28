import { useEffect, useState } from "react";
import type { Conversation } from "../../shared/types";
import type { CodeUsageDashboard } from "../../shared/code-usage-api";
import { ModelChart } from "./ModelChart";
import { useTooltip } from "../ui/Tooltip";
import { useT } from "../i18n";
import {
  activityGrid,
  codeUsage,
  compactTokens,
  heatLevel,
  heatTip,
  tokenComparison,
  withDashboard,
  type UsageRange,
} from "./usageStats";
import "./usage-overview.css";

/**
 * The service's usage for a Sub2API account (null for a local account, or
 * while it loads or cannot be reached: the card then shows local figures).
 */
function useUsageDashboard(range: UsageRange) {
  const [dashboard, setDashboard] = useState<CodeUsageDashboard | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve(window.desktop?.codeUsageDashboard?.(range))
      .then((value) => {
        if (live) setDashboard(value ?? null);
      })
      .catch(() => {
        if (live) setDashboard(null);
      });
    return () => {
      live = false;
    };
  }, [range]);
  return dashboard;
}

const hourLabel = (hour: number) =>
  `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;

/** Code statistics: Overview figures and activity, or tokens by model. */
export function UsageOverview({
  conversations,
}: {
  conversations: Conversation[];
}) {
  const t = useT();
  const [tab, setTab] = useState<"overview" | "models">("overview");
  const [range, setRange] = useState<UsageRange>("all");
  // The comparison names a random book, fixed for as long as the card is shown.
  const [roll] = useState(() => Math.random());
  const dashboard = useUsageDashboard(range);
  const local = codeUsage(conversations, range);
  const usage = dashboard ? withDashboard(local, dashboard) : local;
  const grid = activityGrid(conversations);
  const busiest = Math.max(0, ...grid.map((cell) => cell.count));
  const comparison = tokenComparison(usage.tokens, roll);
  // A day's "Oct 3 — 12" shows in the app's tooltip above the tile, not the
  // browser's native title. One tooltip serves every tile.
  const [dayTip, setDayTip] = useState("");
  const { props: tipProps, tooltip: dayTooltip } = useTooltip(dayTip, {
    placement: "above",
  });
  const stats = [
    ["Sessions", usage.sessions.toLocaleString("en-US")],
    ["Messages", usage.messages.toLocaleString("en-US")],
    ["Total tokens", compactTokens(usage.tokens)],
    ["Active days", String(usage.activeDays)],
    [
      "Peak hour",
      usage.peakHour === undefined ? "—" : hourLabel(usage.peakHour),
    ],
    ["Favorite model", usage.favoriteModel ?? "—"],
  ];
  return (
    <section className="usage-overview">
      <div className="usage-tabs">
        <div role="tablist" aria-label={t("Statistics")}>
          {(
            [
              ["overview", "Overview"],
              ["models", "Models"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? "selected" : ""}
              onClick={() => setTab(value)}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label={t("Range")}>
          {(
            [
              ["all", "All"],
              ["30d", "30d"],
              ["7d", "7d"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="radio"
              aria-checked={range === value}
              className={range === value ? "selected" : ""}
              onClick={() => setRange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === "overview" ? (
        <>
          <div className="usage-grid">
            {stats.map(([label, value]) => (
              <div
                key={label}
                className={
                  label === "Favorite model" ? "usage-model" : undefined
                }
              >
                <span>{t(label)}</span>
                <strong title={value} data-no-translate>
                  {value}
                </strong>
              </div>
            ))}
          </div>
          <div
            className="usage-heatmap"
            role="img"
            aria-label={t("Daily activity heatmap")}
          >
            {grid.map(({ date, count, future }, i) =>
              future ? (
                <span key={i} />
              ) : (
                <span
                  key={i}
                  className={`heat-${heatLevel(count, busiest)}`}
                  onPointerEnter={(event) => {
                    setDayTip(heatTip(date, count));
                    tipProps.onPointerEnter(event);
                  }}
                  onPointerLeave={tipProps.onPointerLeave}
                />
              ),
            )}
          </div>
          {dayTooltip}
          {comparison && <footer data-no-translate>{comparison}</footer>}
        </>
      ) : (
        <ModelChart daily={usage.daily} models={usage.models} />
      )}
    </section>
  );
}
