import { currentLocale } from "../../i18n";
import type {
  UsageGranularity,
  UsageRange,
  UsageTrendPoint,
} from "../../../shared/usage-stats-api";

/** 12,345 → "12.3K", 4,200,000 → "4.2M": tokens and counts read at a glance. */
export function compact(value: number): string {
  return new Intl.NumberFormat(currentLocale(), {
    ...(Math.abs(value) >= 1e4
      ? { notation: "compact" as const, maximumSignificantDigits: 3 }
      : { maximumFractionDigits: 0 }),
  }).format(value);
}

/**
 * Money as the service bills it: four places for small amounts, two above a
 * dollar and for nothing; "$", not the locale's "US$".
 */
export function cost(value: number): string {
  const digits = Math.abs(value) >= 1 || value === 0 ? 2 : 4;
  return new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** 850 → "850 ms", 1,240 → "1.24 s", 75,000 → "1.3 min". */
export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const unit = ms < 1000 ? "millisecond" : ms < 60_000 ? "second" : "minute";
  const value = ms < 1000 ? ms : ms < 60_000 ? ms / 1000 : ms / 60_000;
  return new Intl.NumberFormat(currentLocale(), {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: ms < 1000 ? 0 : ms < 10_000 ? 2 : 1,
  }).format(value);
}

/** A local calendar day as YYYY-MM-DD. */
export function dayOf(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export type Preset = "today" | "7" | "30" | "90" | "custom";

export const presets: { id: Exclude<Preset, "custom">; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
];

/** The range a preset names, ending today; Today reads hour by hour. */
export function presetRange(
  preset: Exclude<Preset, "custom">,
  now = new Date(),
): UsageRange {
  const end = dayOf(now);
  if (preset === "today") return { start: end, end, granularity: "hour" };
  const back = new Date(now);
  back.setDate(back.getDate() - (Number(preset) - 1));
  return { start: dayOf(back), end, granularity: "day" };
}

/** Which preset a range is, or custom. */
export function presetOf(range: UsageRange, now = new Date()): Preset {
  for (const { id } of presets) {
    const p = presetRange(id, now);
    if (
      p.start === range.start &&
      p.end === range.end &&
      p.granularity === range.granularity
    )
      return id;
  }
  return "custom";
}

export interface Bar {
  label: string;
  tokens: number;
  input: number;
  output: number;
  cache: number;
  requests: number;
  cost: number;
  /** Heights as a percentage of the tallest bucket: input, output, cache. */
  heights: [number, number, number];
}

/** The buckets as bars, each stacked from what it took in, gave out and cached. */
export function bars(trend: UsageTrendPoint[]): { bars: Bar[]; max: number } {
  const max = trend.reduce((m, p) => Math.max(m, p.tokens), 0);
  const share = (value: number) => (max ? (value / max) * 100 : 0);
  return {
    max,
    bars: trend.map((p) => ({
      label: p.date,
      tokens: p.tokens,
      input: p.inputTokens,
      output: p.outputTokens,
      cache: p.cacheTokens,
      requests: p.requests,
      cost: p.cost,
      heights: [
        share(p.inputTokens),
        share(p.outputTokens),
        share(p.cacheTokens),
      ],
    })),
  };
}

/** "2026-09-30" → "Sep 30"; "2026-09-30 14:00" → "14:00"; anything else as sent. */
export function bucketLabel(
  label: string,
  granularity: UsageGranularity,
): string {
  const hour = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):\d{2}/.exec(label);
  if (hour && granularity === "hour") return `${hour[1]}:00`;
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(label);
  if (!day) return label;
  return new Date(
    Number(day[1]),
    Number(day[2]) - 1,
    Number(day[3]),
  ).toLocaleDateString(currentLocale(), { month: "short", day: "numeric" });
}
