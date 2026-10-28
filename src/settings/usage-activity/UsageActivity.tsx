import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCw } from "../../ui/glyphs";
import type {
  UsageBreakdown,
  UsageOverview,
  UsageProvider,
  UsageRange,
  UsageRecordPage,
} from "../../../shared/usage-stats-api";
import { currentLocale, t, tf, useT } from "../../i18n";
import type { TabProps } from "../context";
import { compact, cost, presetOf, presetRange, presets } from "./format";
import { Skeleton } from "../../ui/Skeleton";
import "./usage-activity.css";
import "../usage.css";
import { Overview, QuotaRow, Trend, Requests } from "./UsageActivityParts";

/** What the service calls a platform, as people know the provider. */
const providerNames: Record<string, string> = {
  openai: "OpenAI",
  grok: "xAI",
  xai: "xAI",
  anthropic: "Messages API",
  gemini: "Google Gemini",
  antigravity: "Antigravity",
  qwen: "Qwen",
};
const providerName = (platform: string) =>
  providerNames[platform] ??
  platform.charAt(0).toUpperCase() + platform.slice(1);

export const windowNames = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

export function Stat({
  label,
  value,
  lines,
}: {
  label: string;
  value: string;
  lines?: string[];
}) {
  return (
    <div className="ua-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {lines?.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

function Providers({ providers }: { providers: UsageProvider[] }) {
  if (!providers.length) return null;
  return (
    <section className="ua-section" aria-labelledby="ua-providers">
      <h3 id="ua-providers">{t("By provider")}</h3>
      <div className="ua-providers">
        {providers.map((p) => (
          <div className="ua-provider" key={p.platform}>
            <div className="ua-provider-head">
              <b>{providerName(p.platform)}</b>
              <span>{cost(p.cost)}</span>
            </div>
            <p>
              {tf("Today {x}", { x: cost(p.todayCost) })} ·{" "}
              {tf("{n} requests", {
                n: p.requests.toLocaleString(currentLocale()),
              })}{" "}
              · {tf("{x} tokens", { x: compact(p.tokens) })}
            </p>
            {p.quota.map((w) => (
              <QuotaRow key={w.id} window={w} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function Models({ data }: { data: UsageBreakdown | undefined }) {
  const models = data?.models ?? [];
  const total = models.reduce((sum, m) => sum + m.tokens, 0);
  if (!models.length) return null;
  return (
    <section className="ua-section" aria-labelledby="ua-models">
      <h3 id="ua-models">{t("By model")}</h3>
      <div className="ua-models">
        {models.map((m) => {
          const share = total ? (m.tokens / total) * 100 : 0;
          return (
            <div className="ua-model" key={m.model}>
              <div className="ua-model-head">
                <b title={m.model}>{m.model}</b>
                <span>{compact(m.tokens)}</span>
              </div>
              <div className="usage-bar used">
                <span style={{ width: `${Math.max(1, share)}%` }} />
              </div>
              <p>
                {Math.round(share)}% ·{" "}
                {tf("{n} requests", {
                  n: m.requests.toLocaleString(currentLocale()),
                })}{" "}
                · {cost(m.cost)}
                {m.standardCost !== m.cost &&
                  ` (${tf("Standard price {x}", { x: cost(m.standardCost) })})`}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A rate as the bill shows it: 0.25 → "×0.25". */
export const rate = (value: number) =>
  `×${value.toLocaleString(currentLocale(), { maximumFractionDigits: 3 })}`;

/**
 * Settings → Usage, under the plan's own limits: what the account used, as
 * the Sub2API dashboard reports it (totals and today, each provider and its
 * quotas, the use over a range by day or hour and by model, the requests) in
 * the page's own type and bars. Renders nothing for an account without a
 * Claudex service.
 */
export default function UsageActivity({ onError }: TabProps) {
  useT();
  const [overview, setOverview] = useState<UsageOverview | null>();
  const [range, setRange] = useState<UsageRange>(() => presetRange("7"));
  const [breakdown, setBreakdown] = useState<UsageBreakdown>();
  const [loadingRange, setLoadingRange] = useState(false);
  const [page, setPage] = useState(1);
  const [model, setModel] = useState("");
  const [records, setRecords] = useState<UsageRecordPage>();
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const staleRange = useRef(0);
  const staleRecords = useRef(0);

  const loadOverview = useCallback(() => {
    setLoadingOverview(true);
    return Promise.resolve()
      .then(() => window.desktop.usageOverview())
      .then(setOverview, (error: unknown) => {
        setOverview(null);
        onError(error);
      })
      .finally(() => setLoadingOverview(false));
  }, [onError]);
  useEffect(() => void loadOverview(), [loadOverview]);

  useEffect(() => {
    if (!overview) return;
    const mine = ++staleRange.current;
    setLoadingRange(true);
    Promise.resolve()
      .then(() => window.desktop.usageBreakdown(range))
      .then(
        (value) => mine === staleRange.current && setBreakdown(value),
        (error: unknown) => mine === staleRange.current && onError(error),
      )
      .finally(() => mine === staleRange.current && setLoadingRange(false));
  }, [
    overview === null || overview === undefined,
    range.start,
    range.end,
    range.granularity,
  ]);

  useEffect(() => {
    if (!overview) return;
    const mine = ++staleRecords.current;
    setLoadingRecords(true);
    Promise.resolve()
      .then(() =>
        window.desktop.usageRecords({
          page,
          pageSize: 10,
          start: range.start,
          end: range.end,
          ...(model ? { model } : {}),
        }),
      )
      .then(
        (value) => mine === staleRecords.current && setRecords(value),
        (error: unknown) => mine === staleRecords.current && onError(error),
      )
      .finally(() => mine === staleRecords.current && setLoadingRecords(false));
  }, [
    overview === null || overview === undefined,
    page,
    model,
    range.start,
    range.end,
  ]);

  if (overview === null) return null;
  if (overview === undefined)
    return (
      <div
        className="ua"
        role="status"
        aria-busy="true"
        aria-label={t("Loading")}
      >
        <div className="ua-head">
          <h2 className="usage-heading">{t("Activity")}</h2>
        </div>
        <div className="ua-stats">
          {Array.from({ length: 6 }, (_, i) => (
            <div className="ua-stat ua-stat-loading" key={i}>
              <Skeleton width={80} height={13} />
              <Skeleton width={120} height={28} />
              <Skeleton width={140} height={13} />
            </div>
          ))}
        </div>
        <div className="ua-section ua-loading">
          <Skeleton width={120} height={22} />
          <Skeleton height={8} round />
          <Skeleton height={8} round />
        </div>
      </div>
    );
  const preset = presetOf(range);
  const choose = (next: UsageRange) => {
    setPage(1);
    setRange(next);
  };
  return (
    <div className="ua">
      <div className="ua-head">
        <h2 className="usage-heading">{t("Activity")}</h2>
        <button
          type="button"
          className={`usage-refresh ${loadingOverview || loadingRange ? "loading" : ""}`}
          aria-label={t("Refresh")}
          disabled={loadingOverview || loadingRange}
          onClick={() => {
            void loadOverview();
            setPage(1);
            setRange({ ...range });
          }}
        >
          <RotateCw size={16} strokeWidth={1.75} />
        </button>
      </div>
      <Overview overview={overview} />
      <Providers providers={overview.providers} />

      <section className="ua-section" aria-labelledby="ua-trend">
        <div className="ua-section-head">
          <h3 id="ua-trend">{t("Usage over time")}</h3>
          <div className="ua-range">
            <div className="ua-segment" role="group" aria-label={t("Range")}>
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={preset === p.id ? "on" : ""}
                  aria-pressed={preset === p.id}
                  onClick={() => choose(presetRange(p.id))}
                >
                  {t(p.label)}
                </button>
              ))}
            </div>
            <div
              className="ua-segment"
              role="group"
              aria-label={t("Granularity")}
            >
              {(["day", "hour"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  className={range.granularity === g ? "on" : ""}
                  aria-pressed={range.granularity === g}
                  onClick={() => choose({ ...range, granularity: g })}
                >
                  {t(g === "day" ? "By day" : "By hour")}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="ua-dates">
          <label>
            <span>{t("From")}</span>
            <input
              type="date"
              value={range.start}
              max={range.end}
              onChange={(event) =>
                event.target.value &&
                choose({ ...range, start: event.target.value })
              }
            />
          </label>
          <label>
            <span>{t("To")}</span>
            <input
              type="date"
              value={range.end}
              min={range.start}
              onChange={(event) =>
                event.target.value &&
                choose({ ...range, end: event.target.value })
              }
            />
          </label>
        </div>
        <Trend data={breakdown} range={range} loading={loadingRange} />
      </section>

      <Models data={breakdown} />
      <Requests
        page={records}
        loading={loadingRecords}
        models={(breakdown?.models ?? []).map((m) => m.model)}
        model={model}
        onModel={(value) => {
          setPage(1);
          setModel(value);
        }}
        onPage={setPage}
      />
    </div>
  );
}
