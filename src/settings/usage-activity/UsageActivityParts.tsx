import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Database,
  ChevronLeft,
  ChevronRight,
} from "../../ui/glyphs";
import type {
  UsageBreakdown,
  UsageOverview,
  UsageQuotaWindow,
  UsageRange,
  UsageRecord,
  UsageRecordPage,
} from "../../../shared/usage-stats-api";
import { collectionTime } from "../../collections/collection-time";
import { currentLocale, t, tf } from "../../i18n";
import { bars, bucketLabel, compact, cost, duration } from "./format";
import { Skeleton } from "../../ui/Skeleton";
import "./usage-activity.css";
import "../usage.css";
import { windowNames, Stat, rate } from "./UsageActivity";

export function Overview({ overview }: { overview: UsageOverview }) {
  const { totals } = overview;
  const tokenLine = (input: number, output: number, cache: number) =>
    `${t("Input")} ${compact(input)} · ${t("Output")} ${compact(output)} · ${t("Cache")} ${compact(cache)}`;
  return (
    <dl className="ua-stats">
      <Stat
        label={t("Requests today")}
        value={totals.todayRequests.toLocaleString(currentLocale())}
        lines={[
          tf("All time {n}", {
            n: totals.requests.toLocaleString(currentLocale()),
          }),
        ]}
      />
      <Stat
        label={t("Cost today")}
        value={cost(totals.todayCost)}
        lines={[
          tf("Standard price {x}", { x: cost(totals.todayStandardCost) }),
          tf("All time {x}", { x: cost(totals.cost) }),
        ]}
      />
      <Stat
        label={t("Tokens today")}
        value={compact(totals.todayTokens)}
        lines={[
          tokenLine(
            totals.todayInputTokens,
            totals.todayOutputTokens,
            totals.todayCacheTokens,
          ),
          tf("All time {x}", { x: compact(totals.tokens) }),
        ]}
      />
      <Stat
        label={t("Speed")}
        value={`${compact(totals.rpm)} RPM`}
        lines={[`${compact(totals.tpm)} TPM`, t("Over the last five minutes")]}
      />
      <Stat
        label={t("Average response")}
        value={duration(totals.averageDurationMs)}
      />
      <Stat
        label={t("API keys")}
        value={String(totals.apiKeys)}
        lines={[tf("{n} active", { n: totals.activeApiKeys })]}
      />
    </dl>
  );
}

export function QuotaRow({ window }: { window: UsageQuotaWindow }) {
  const off = window.limit === 0;
  const percent =
    window.limit && window.limit > 0
      ? Math.min(100, (window.used / window.limit) * 100)
      : 0;
  const full = !off && percent >= 100;
  return (
    <div className="ua-quota">
      <span>{t(windowNames[window.id])}</span>
      <div
        className={`usage-bar${full ? " full" : percent > 0 ? " used" : ""}`}
        role="progressbar"
        aria-label={t(windowNames[window.id])}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(off ? 0 : full ? 100 : percent)}
      >
        <span style={{ width: `${full ? 100 : percent}%` }} />
      </div>
      <em className={full ? "full" : ""}>
        {off
          ? t("Turned off")
          : window.limit === null
            ? // No limit: the spend alone, never "/ $0.00".
              cost(window.used)
            : `${cost(window.used)} / ${cost(window.limit)}`}
      </em>
      {window.resetsAt && !off && (
        <small>
          {tf("Resets {x}", {
            x: new Date(window.resetsAt).toLocaleString(currentLocale(), {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }),
          })}
        </small>
      )}
    </div>
  );
}

export function Trend({
  data,
  range,
  loading,
}: {
  data: UsageBreakdown | undefined;
  range: UsageRange;
  loading: boolean;
}) {
  const [hover, setHover] = useState<number>();
  const chart = useMemo(() => bars(data?.trend ?? []), [data]);
  const total = (data?.trend ?? []).reduce(
    (sum, p) => ({
      tokens: sum.tokens + p.tokens,
      requests: sum.requests + p.requests,
      cost: sum.cost + p.cost,
    }),
    { tokens: 0, requests: 0, cost: 0 },
  );
  if (!data) return loading ? <Skeleton height={160} /> : null;
  if (!chart.bars.length || !chart.max)
    return <p className="ua-empty">{t("No usage in this range.")}</p>;
  const shown = hover === undefined ? undefined : chart.bars[hover];
  const last = chart.bars.length - 1;
  const ticks = [0, Math.floor(last / 2), last].filter(
    (n, i, all) => all.indexOf(n) === i,
  );
  return (
    <div className={`ua-trend${loading ? " loading" : ""}`}>
      <p className="ua-summary">
        {tf("{x} tokens", { x: compact(total.tokens) })} ·{" "}
        {tf("{n} requests", {
          n: total.requests.toLocaleString(currentLocale()),
        })}{" "}
        · {cost(total.cost)}
      </p>
      <div className="ua-chart" onMouseLeave={() => setHover(undefined)}>
        <span className="ua-axis top">{compact(chart.max)}</span>
        <span className="ua-axis mid">{compact(chart.max / 2)}</span>
        <div
          className="ua-bars"
          style={{ gap: chart.bars.length <= 14 ? 8 : 2 }}
        >
          {chart.bars.map((bar, index) => (
            <div
              key={bar.label + index}
              className={`ua-bar${hover === index ? " hover" : ""}`}
              onMouseEnter={() => setHover(index)}
              title={`${bucketLabel(bar.label, range.granularity)}: ${compact(bar.tokens)} tokens`}
            >
              <span
                className="cache"
                style={{ height: `${bar.heights[2]}%` }}
              />
              <span
                className="output"
                style={{ height: `${bar.heights[1]}%` }}
              />
              <span
                className="input"
                style={{ height: `${bar.heights[0]}%` }}
              />
            </div>
          ))}
        </div>
        {shown && (
          <div
            className="ua-tip"
            style={{
              // At the hovered bar's centre, past the axis column; it opens
              // rightwards over the first bar and leftwards over the last, so
              // it never leaves the page's scroll area.
              left: `calc(var(--ua-axis-width) + (100% - var(--ua-axis-width)) * ${((hover ?? 0) + 0.5) / chart.bars.length})`,
              transform: `translateX(-${((hover ?? 0) / Math.max(1, last)) * 100}%)`,
            }}
            role="status"
          >
            <b>{bucketLabel(shown.label, range.granularity)}</b>
            <span>
              {t("Input")} {compact(shown.input)}
            </span>
            <span>
              {t("Output")} {compact(shown.output)}
            </span>
            <span>
              {t("Cache")} {compact(shown.cache)}
            </span>
            <span>
              {tf("{n} requests", {
                n: shown.requests.toLocaleString(currentLocale()),
              })}{" "}
              · {cost(shown.cost)}
            </span>
          </div>
        )}
      </div>
      <div className="ua-ticks">
        {ticks.map((n) => (
          <span key={n}>
            {bucketLabel(chart.bars[n]!.label, range.granularity)}
          </span>
        ))}
      </div>
      <div className="ua-legend">
        <span className="input">{t("Input")}</span>
        <span className="output">{t("Output")}</span>
        <span className="cache">{t("Cache")}</span>
      </div>
    </div>
  );
}

/**
 * One request: the model with its key and time, the tokens in and out with the
 * cache under them, what it cost and at which rate, the time to the first token
 * and in all; it opens to every detail the service keeps.
 */
function RequestRow({ record: r }: { record: UsageRecord }) {
  const details: [string, string][] = [
    [t("Time"), r.at ? new Date(r.at).toLocaleString(currentLocale()) : "—"],
    [t("Request ID"), r.requestId],
    [t("API key"), r.keyName],
    [t("Group"), r.group],
    [t("Endpoint"), r.endpoint],
    [t("Type"), r.stream ? t("Streaming") : t("Non-streaming")],
    [t("Effort"), r.effort],
    [t("Multiplier"), r.multiplier === null ? "" : rate(r.multiplier)],
    [
      t("Input"),
      `${r.inputTokens.toLocaleString(currentLocale())} · ${cost(r.inputCost)}`,
    ],
    [
      t("Output"),
      `${r.outputTokens.toLocaleString(currentLocale())} · ${cost(r.outputCost)}`,
    ],
    [
      t("Cache read"),
      r.cacheReadTokens
        ? `${r.cacheReadTokens.toLocaleString(currentLocale())} · ${cost(r.cacheReadCost)}`
        : "",
    ],
    [
      t("Cache write"),
      r.cacheWriteTokens
        ? `${r.cacheWriteTokens.toLocaleString(currentLocale())} · ${cost(r.cacheWriteCost)}`
        : "",
    ],
    [t("Images"), r.images ? `${r.images} · ${cost(r.imageCost)}` : ""],
    [t("Standard cost"), cost(r.standardCost)],
    [t("Charged"), cost(r.cost)],
    [t("First token"), r.firstTokenMs === null ? "" : duration(r.firstTokenMs)],
    [t("Total"), duration(r.durationMs)],
    [t("IP"), r.ip],
    [t("Client"), r.client],
  ];
  return (
    <details className="ua-record">
      <summary>
        <span className="ua-record-model">
          <b title={r.model}>{r.model}</b>
          <small>
            {[r.keyName, r.at ? collectionTime(r.at) : ""]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </span>
        <span className="ua-record-tokens">
          <span>
            <ArrowDown size={12} aria-label={t("Input")} />
            {compact(r.inputTokens)}
            <ArrowUp size={12} aria-label={t("Output")} />
            {compact(r.outputTokens)}
          </span>
          {r.cacheTokens > 0 && (
            <small>
              <Database size={12} aria-label={t("Cache")} />
              {compact(r.cacheTokens)}
            </small>
          )}
        </span>
        <span className="ua-record-cost">
          <span>{cost(r.cost)}</span>
          {r.multiplier !== null && <small>{rate(r.multiplier)}</small>}
        </span>
        <span className="ua-record-latency">
          <span>
            <small>{t("First token")}</small>{" "}
            {r.firstTokenMs === null ? "—" : duration(r.firstTokenMs)}
          </span>
          <span>
            <small>{t("Total")}</small> {duration(r.durationMs)}
          </span>
        </span>
        <ChevronRight
          size={14}
          className="ua-record-chevron"
          aria-hidden="true"
        />
      </summary>
      <dl className="ua-record-details">
        {details
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
    </details>
  );
}

export function Requests({
  page,
  loading,
  models,
  model,
  onModel,
  onPage,
}: {
  page: UsageRecordPage | undefined;
  loading: boolean;
  models: string[];
  model: string;
  onModel: (model: string) => void;
  onPage: (page: number) => void;
}) {
  return (
    <section className="ua-section" aria-labelledby="ua-requests">
      <div className="ua-section-head">
        <h3 id="ua-requests">{t("Requests")}</h3>
        <select
          className="ua-select"
          value={model}
          aria-label={t("Model")}
          onChange={(event) => onModel(event.target.value)}
        >
          <option value="">{t("All models")}</option>
          {models.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {!page ? (
        loading ? (
          <div className="ua-loading">
            <Skeleton height={20} />
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        ) : null
      ) : !page.items.length ? (
        <p className="ua-empty">{t("No requests in this range.")}</p>
      ) : (
        <>
          <div className={`ua-records${loading ? " loading" : ""}`}>
            <div className="ua-record-head" aria-hidden="true">
              <span>{t("Model")}</span>
              <span>{t("Tokens")}</span>
              <span>{t("Cost")}</span>
              <span>{t("Latency")}</span>
            </div>
            {page.items.map((r) => (
              <RequestRow key={r.id} record={r} />
            ))}
          </div>
          <div className="ua-pager">
            <button
              type="button"
              aria-label={t("Previous page")}
              disabled={loading || page.page <= 1}
              onClick={() => onPage(page.page - 1)}
            >
              <ChevronLeft size={16} strokeWidth={1.75} />
            </button>
            <span>
              {tf("Page {n} of {m}", { n: page.page, m: page.pages })} ·{" "}
              {tf("{n} requests", {
                n: page.total.toLocaleString(currentLocale()),
              })}
            </span>
            <button
              type="button"
              aria-label={t("Next page")}
              disabled={loading || page.page >= page.pages}
              onClick={() => onPage(page.page + 1)}
            >
              <ChevronRight size={16} strokeWidth={1.75} />
            </button>
          </div>
        </>
      )}
    </section>
  );
}
