import { useEffect, useMemo, useRef, useState } from "react";
// @ts-expect-error Pinned official settings component.
import { GG as Section } from "./shared-1-B16QIYNI.js";
// @ts-expect-error Pinned official controls.
import {
  tw as Button,
  Ef as TextInput,
  uR as Skeleton,
} from "./shared-frame-DH1u5uQk.js";
// @ts-expect-error Pinned official data table.
import { t as DataTable } from "./ce802b15a-CA_45z3b.js";
// @ts-expect-error Pinned official selection menu.
import { t as Dropdown } from "./c323610d7-C6-KSPO9.js";
// @ts-expect-error Pinned official usage meter.
import { t as Progress } from "./c17c9c40b-CQVGk63d.js";
import {
  useUsageActivity,
  type UsageActivityClient,
} from "../../src/settings/usage-activity/use-usage-activity";
import {
  bars,
  bucketLabel,
  compact,
  cost,
  duration,
  presetOf,
  presetRange,
  presets,
} from "../../src/settings/usage-activity/format";
import { currentLocale, t, tf, useT } from "../../src/i18n";
import { collectionTime } from "../../src/collections/collection-time";
import type {
  UsageRecord,
  UsageTrendPoint,
  UsageRange,
} from "../../shared/usage-stats-api";

const count = (value: number) => value.toLocaleString(currentLocale());
const rate = (value: number) =>
  `×${value.toLocaleString(currentLocale(), { maximumFractionDigits: 3 })}`;

function Trend({
  points,
  range,
  loading,
}: {
  points: UsageTrendPoint[];
  range: UsageRange;
  loading: boolean;
}) {
  const chart = useMemo(() => bars(points), [points]);
  const [active, setActive] = useState<number>();
  const selected = active === undefined ? undefined : chart.bars[active];
  const totals = points.reduce(
    (sum, row) => ({
      tokens: sum.tokens + row.tokens,
      requests: sum.requests + row.requests,
      cost: sum.cost + row.cost,
    }),
    { tokens: 0, requests: 0, cost: 0 },
  );
  if (loading)
    return (
      <div aria-busy="true" aria-label={t("Loading")}>
        <Skeleton height={160} />
      </div>
    );
  if (!points.length)
    return (
      <p className="text-footnote text-secondary">
        {t("No requests in this range.")}
      </p>
    );
  return (
    <div>
      <p className="text-footnote text-secondary">
        {tf("{x} tokens", { x: compact(totals.tokens) })} ·{" "}
        {tf("{n} requests", { n: count(totals.requests) })} ·{" "}
        {cost(totals.cost)}
      </p>
      <div
        className="clx-usage-chart"
        style={{ gap: chart.bars.length > 90 ? 0 : 2 }}
        aria-label={t("Usage over time")}
        onMouseLeave={() => setActive(undefined)}
      >
        {chart.bars.map((bar, index) => (
          <button
            key={`${bar.label}:${index}`}
            type="button"
            className="clx-usage-bar focus-visible:shadow-focus"
            tabIndex={index === (active ?? 0) ? 0 : -1}
            onMouseEnter={() => setActive(index)}
            onFocus={() => setActive(index)}
            onBlur={() => setActive(undefined)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? Math.min(chart.bars.length - 1, index + 1)
                  : event.key === "ArrowLeft"
                    ? Math.max(0, index - 1)
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? chart.bars.length - 1
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              (
                event.currentTarget.parentElement?.children[next] as
                  HTMLButtonElement | undefined
              )?.focus();
            }}
            aria-label={`${bucketLabel(bar.label, range.granularity)} · ${t("Input")} ${count(bar.input)} · ${t("Output")} ${count(bar.output)} · ${t("Cache")} ${count(bar.cache)} · ${cost(bar.cost)}`}
          >
            <span
              className="clx-usage-input"
              style={{ height: `${bar.heights[0]}%` }}
            />
            <span
              className="clx-usage-output"
              style={{ height: `${bar.heights[1]}%` }}
            />
            <span
              className="clx-usage-cache"
              style={{ height: `${bar.heights[2]}%` }}
            />
          </button>
        ))}
      </div>
      <div className="clx-usage-chart-labels text-footnote text-secondary">
        <span>{bucketLabel(chart.bars[0].label, range.granularity)}</span>
        <span>{bucketLabel(chart.bars.at(-1)!.label, range.granularity)}</span>
      </div>
      <p
        className="clx-usage-chart-detail text-footnote text-secondary"
        role="status"
      >
        {selected
          ? `${bucketLabel(selected.label, range.granularity)} · ${t("Input")} ${count(selected.input)} · ${t("Output")} ${count(selected.output)} · ${t("Cache")} ${count(selected.cache)} · ${tf("{n} requests", { n: count(selected.requests) })} · ${cost(selected.cost)}`
          : `${t("Input")} · ${t("Output")} · ${t("Cache")}`}
      </p>
    </div>
  );
}

function RequestDetails({ row }: { row: UsageRecord }) {
  const details: [string, string][] = [
    [t("Model"), row.model],
    [
      t("Time"),
      row.at ? new Date(row.at).toLocaleString(currentLocale()) : "—",
    ],
    [t("Request ID"), row.requestId],
    [t("API key"), row.keyName],
    [t("Group"), row.group],
    [t("Endpoint"), row.endpoint],
    [t("Type"), t(row.stream ? "Streaming" : "Non-streaming")],
    [t("Effort"), row.effort],
    [t("Input"), `${count(row.inputTokens)} · ${cost(row.inputCost)}`],
    [t("Output"), `${count(row.outputTokens)} · ${cost(row.outputCost)}`],
    [
      t("Cache read"),
      row.cacheReadTokens
        ? `${count(row.cacheReadTokens)} · ${cost(row.cacheReadCost)}`
        : "",
    ],
    [
      t("Cache write"),
      row.cacheWriteTokens
        ? `${count(row.cacheWriteTokens)} · ${cost(row.cacheWriteCost)}`
        : "",
    ],
    [
      t("Images"),
      row.images ? `${count(row.images)} · ${cost(row.imageCost)}` : "",
    ],
    [t("Standard cost"), cost(row.standardCost)],
    [t("Charged"), cost(row.cost)],
    [t("Multiplier"), row.multiplier === null ? "" : rate(row.multiplier)],
    [t("First token"), duration(row.firstTokenMs)],
    [t("Total"), duration(row.durationMs)],
    [t("IP"), row.ip],
    [t("Client"), row.client],
  ];
  return (
    <dl className="clx-usage-details text-body">
      {details
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label}>
            <dt className="text-secondary">{label}</dt>
            <dd className="text-primary tabular-nums">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function OfficialUsageActivity({
  client,
  onError,
  refreshRevision = 0,
}: {
  client: UsageActivityClient;
  onError: (error: unknown) => void;
  refreshRevision?: number;
}) {
  useT();
  const state = useUsageActivity(client, onError);
  const {
    overview,
    range,
    breakdown,
    records,
    loadingOverview,
    loadingRange,
    loadingRecords,
    page,
    model,
  } = state;
  const [selected, setSelected] = useState<UsageRecord | null>(null);
  const requestTitle = useRef<HTMLHeadingElement>(null);
  const previousRefresh = useRef(refreshRevision);
  useEffect(() => {
    if (previousRefresh.current === refreshRevision) return;
    previousRefresh.current = refreshRevision;
    setSelected(null);
    state.refresh();
  }, [refreshRevision]);
  useEffect(() => setSelected(null), [page, model, range.start, range.end]);
  useEffect(() => {
    if (selected) requestTitle.current?.focus();
  }, [selected]);
  const columns = useMemo(
    () => [
      {
        id: "model",
        header: t("Model"),
        accessorKey: "model",
        meta: { minSize: 160 },
        cell: ({ row: { original: row } }: any) => (
          <div className="flex min-w-0 flex-col gap-xs">
            <span className="text-body text-primary" title={row.model}>
              {row.model}
            </span>
            <span className="text-footnote text-secondary">
              {[row.keyName, row.at ? collectionTime(row.at) : ""]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        ),
      },
      {
        id: "tokens",
        header: t("Tokens"),
        meta: { minSize: 150 },
        cell: ({ row: { original: row } }: any) => (
          <div className="flex flex-col gap-xs">
            <div className="clx-usage-token-values">
              <span>
                <span className="text-secondary">{t("Input")}</span>{" "}
                {compact(row.inputTokens)}
              </span>
              <span>
                <span className="text-secondary">{t("Output")}</span>{" "}
                {compact(row.outputTokens)}
              </span>
            </div>
            {row.cacheTokens > 0 && (
              <span className="text-footnote text-secondary">
                {t("Cache")} {compact(row.cacheTokens)}
              </span>
            )}
          </div>
        ),
      },
      {
        id: "cost",
        header: t("Cost"),
        accessorKey: "cost",
        meta: {
          minSize: 110,
          align: "end",
          cellClassName: "tabular-nums whitespace-nowrap",
        },
        cell: ({ row: { original: row } }: any) => (
          <div className="flex flex-col gap-xs">
            <span className="text-body text-primary">{cost(row.cost)}</span>
            {row.multiplier !== null && (
              <span className="text-footnote text-secondary">
                {rate(row.multiplier)}
              </span>
            )}
          </div>
        ),
      },
    ],
    [currentLocale()],
  );
  const refresh = (
    <Button
      variant="secondary"
      size="sm"
      disabled={loadingOverview || loadingRange || loadingRecords}
      onClick={() => {
        setSelected(null);
        state.refresh();
      }}
    >
      {t("Refresh")}
    </Button>
  );
  if (!overview)
    return (
      <Section title={t("Activity")} action={refresh}>
        {overview === undefined ? (
          <div role="status" aria-busy="true">
            <Skeleton height={80} />
          </div>
        ) : (
          <p className="text-footnote text-secondary">
            {t("Usage could not be loaded.")}
          </p>
        )}
      </Section>
    );
  const totals = overview.totals;
  const stats = [
    [
      t("Requests today"),
      count(totals.todayRequests),
      tf("All time {n}", { n: count(totals.requests) }),
    ],
    [
      t("Cost today"),
      cost(totals.todayCost),
      `${tf("Standard price {x}", { x: cost(totals.todayStandardCost) })} · ${tf("All time {x}", { x: cost(totals.cost) })}`,
    ],
    [
      t("Tokens today"),
      compact(totals.todayTokens),
      `${t("Input")} ${compact(totals.todayInputTokens)} · ${t("Output")} ${compact(totals.todayOutputTokens)} · ${t("Cache")} ${compact(totals.todayCacheTokens)}`,
    ],
    [
      t("Speed"),
      `${compact(totals.rpm)} RPM`,
      `${compact(totals.tpm)} TPM · ${t("Over the last five minutes")}`,
    ],
    [t("Average response"), duration(totals.averageDurationMs), ""],
    [
      t("API keys"),
      count(totals.apiKeys),
      tf("{n} active", { n: totals.activeApiKeys }),
    ],
  ];
  const models = breakdown?.models ?? [];
  const modelTotal = models.reduce((sum, row) => sum + row.tokens, 0);
  const preset = presetOf(range);
  return (
    <div className="clx-usage-activity">
      <Section title={t("Activity")}>
        <dl className="clx-usage-stats">
          {stats.map(([label, value, detail]) => (
            <div key={label}>
              <dt className="text-footnote text-secondary">{label}</dt>
              <dd className="text-heading-semibold text-primary tabular-nums">
                {value}
              </dd>
              {detail && (
                <p className="text-footnote text-secondary">{detail}</p>
              )}
            </div>
          ))}
        </dl>
      </Section>
      {overview.providers.length > 0 && (
        <Section title={t("By provider")}>
          <div className="flex flex-col gap-lg">
            {overview.providers.map((provider) => (
              <div key={provider.platform}>
                <div className="clx-usage-heading-row text-body">
                  <span>
                    {(
                      {
                        openai: "OpenAI",
                        anthropic: "Messages API",
                        grok: "xAI",
                        gemini: "Google Gemini",
                      } as Record<string, string>
                    )[provider.platform] ?? provider.platform}
                  </span>
                  <span className="tabular-nums">{cost(provider.cost)}</span>
                </div>
                <p className="text-footnote text-secondary">
                  {tf("Today {x}", { x: cost(provider.todayCost) })} ·{" "}
                  {tf("{n} requests", { n: count(provider.requests) })} ·{" "}
                  {tf("{x} tokens", { x: compact(provider.tokens) })}
                </p>
                {provider.quota.map((quota) => (
                  <div key={quota.id} className="clx-usage-quota">
                    <span className="text-footnote text-secondary">
                      {t(
                        (
                          {
                            daily: "Daily",
                            weekly: "Weekly",
                            monthly: "Monthly",
                          } as const
                        )[quota.id],
                      )}
                    </span>
                    <Progress.Root
                      value={
                        quota.limit && quota.limit > 0
                          ? Math.min(100, (quota.used / quota.limit) * 100)
                          : 0
                      }
                      max={100}
                      aria-label={quota.id}
                    >
                      <Progress.Track>
                        <Progress.Indicator />
                      </Progress.Track>
                    </Progress.Root>
                    <span className="text-footnote text-secondary tabular-nums">
                      {quota.limit === 0
                        ? t("Turned off")
                        : quota.limit === null
                          ? cost(quota.used)
                          : `${cost(quota.used)} / ${cost(quota.limit)}`}
                    </span>
                    {quota.resetsAt && quota.limit !== 0 && (
                      <span className="clx-usage-quota-reset text-footnote text-secondary">
                        {tf("Resets {x}", {
                          x: new Date(quota.resetsAt).toLocaleString(
                            currentLocale(),
                          ),
                        })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>
      )}
      <Section title={t("Usage over time")}>
        <div
          className="clx-usage-controls"
          role="group"
          aria-label={t("Range")}
        >
          <Dropdown
            variant="secondary"
            size="sm"
            label={t(
              presets.find((item) => item.id === preset)?.label ?? "Custom",
            )}
            items={presets.map((item) => ({
              label: t(item.label),
              checked: preset === item.id,
              checkedRole: "radio",
              onSelect: () => state.chooseRange(presetRange(item.id)),
            }))}
          />
          <Dropdown
            variant="secondary"
            size="sm"
            label={t(range.granularity === "day" ? "By day" : "By hour")}
            items={(["day", "hour"] as const).map((value) => ({
              label: t(value === "day" ? "By day" : "By hour"),
              checked: range.granularity === value,
              checkedRole: "radio",
              onSelect: () =>
                state.chooseRange({ ...range, granularity: value }),
            }))}
          />
          <label className="clx-usage-date text-footnote text-secondary">
            <span>{t("From")}</span>
            <TextInput
              type="date"
              size="sm"
              aria-label={t("From")}
              value={range.start}
              max={range.end}
              onChange={(event: any) =>
                event.target.value &&
                state.chooseRange({ ...range, start: event.target.value })
              }
            />
          </label>
          <label className="clx-usage-date text-footnote text-secondary">
            <span>{t("To")}</span>
            <TextInput
              type="date"
              size="sm"
              aria-label={t("To")}
              value={range.end}
              min={range.start}
              onChange={(event: any) =>
                event.target.value &&
                state.chooseRange({ ...range, end: event.target.value })
              }
            />
          </label>
        </div>
        {state.breakdownFailed ? (
          <div
            role="alert"
            className="flex items-center gap-md text-footnote text-secondary"
          >
            <span>{t("Usage could not be loaded.")}</span>
            <Button size="sm" variant="secondary" onClick={state.refresh}>
              {t("Try again")}
            </Button>
          </div>
        ) : (
          <Trend
            points={breakdown?.trend ?? []}
            range={range}
            loading={loadingRange || breakdown === undefined}
          />
        )}
      </Section>
      {models.length > 0 && (
        <Section title={t("By model")}>
          <div className="flex flex-col gap-lg">
            {models.map((row) => (
              <div key={row.model}>
                <div className="clx-usage-heading-row text-body">
                  <span>{row.model}</span>
                  <span className="tabular-nums">{compact(row.tokens)}</span>
                </div>
                <Progress.Root
                  value={modelTotal ? (row.tokens / modelTotal) * 100 : 0}
                  max={100}
                  aria-label={row.model}
                >
                  <Progress.Track>
                    <Progress.Indicator />
                  </Progress.Track>
                </Progress.Root>
                <p className="text-footnote text-secondary">
                  {tf("{n} requests", { n: count(row.requests) })} ·{" "}
                  {cost(row.cost)}
                  {row.standardCost !== row.cost &&
                    ` · ${tf("Standard price {x}", { x: cost(row.standardCost) })}`}
                </p>
              </div>
            ))}
          </div>
        </Section>
      )}
      <Section
        title={selected ? t("Request details") : t("Requests")}
        titleRef={requestTitle}
        dividers={false}
        action={
          selected ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSelected(null);
                requestAnimationFrame(() => requestTitle.current?.focus());
              }}
            >
              {t("Back")}
            </Button>
          ) : (
            <Dropdown
              variant="secondary"
              size="sm"
              className="clx-usage-model-filter"
              label={model || t("All models")}
              items={["", ...models.map((row) => row.model)].map((value) => ({
                label: value || t("All models"),
                checked: model === value,
                checkedRole: "radio",
                onSelect: () => state.chooseModel(value),
              }))}
            />
          )
        }
      >
        {selected ? (
          <RequestDetails row={selected} />
        ) : (
          <>
            {state.recordsFailed ? (
              <div
                role="alert"
                className="flex items-center gap-md text-footnote text-secondary"
              >
                <span>{t("Usage could not be loaded.")}</span>
                <Button size="sm" variant="secondary" onClick={state.refresh}>
                  {t("Try again")}
                </Button>
              </div>
            ) : (
              <DataTable
                columns={columns}
                data={records?.items ?? []}
                getRowKey={(row: UsageRecord) => String(row.id)}
                aria-label={t("Requests")}
                isLoading={loadingRecords || records === undefined}
                skeletonRowCount={3}
                emptyState={t("No requests in this range.")}
                onRowClick={setSelected}
              />
            )}
            {records && (
              <div
                className="clx-usage-pager text-footnote text-secondary"
                role="group"
                aria-label={t("Requests")}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loadingRecords || records.page <= 1}
                  onClick={() => state.setPage(records.page - 1)}
                >
                  {t("Previous page")}
                </Button>
                <span>
                  {tf("Page {n} of {m}", { n: records.page, m: records.pages })}{" "}
                  · {tf("{n} requests", { n: count(records.total) })}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loadingRecords || records.page >= records.pages}
                  onClick={() => state.setPage(records.page + 1)}
                >
                  {t("Next page")}
                </Button>
              </div>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
