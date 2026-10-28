import type { Conversation, Turn } from "../../shared/types";
import type { CodeUsageDashboard } from "../../shared/code-usage-api";
import { formatText } from "../i18n";

export type UsageRange = "all" | "30d" | "7d";
const day = 86_400_000;

export type ModelUsage = {
  model: string;
  input: number;
  output: number;
  share: number;
};
export type DayUsage = { date: Date; byModel: Record<string, number> };

/** Local midnight of a timestamp. */
function dayStart(at: number) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Token usage of one turn: its own counts when the runtime reported them,
 * otherwise nothing (older turns kept only thread totals).
 */
function turnUsage(turn: Turn) {
  return { input: turn.inputTokens ?? 0, output: turn.outputTokens ?? 0 };
}

type Entry = { at: number; model: string; input: number; output: number };

/**
 * Usage entries per turn. A conversation whose turns carry no token counts
 * contributes its thread totals on the day of its last turn instead.
 */
function entries(conversations: Conversation[]): Entry[] {
  return conversations.flatMap((c) => {
    const turns = c.turns.map((t) => ({
      at: t.createdAt,
      model: c.model,
      ...turnUsage(t),
    }));
    if (turns.some((t) => t.input || t.output) || !c.usage || !c.turns.length)
      return turns;
    const last = c.turns.at(-1)!;
    const cached = (c.usage as { cachedInputTokens?: number })
      .cachedInputTokens;
    return [
      ...turns,
      {
        at: last.createdAt,
        model: c.model,
        input: Math.max(0, c.usage.inputTokens - (cached ?? 0)),
        output: c.usage.outputTokens,
      },
    ];
  });
}

/** Code usage for the home page's Overview and Models views. */
export function codeUsage(
  conversations: Conversation[],
  range: UsageRange,
  now = Date.now(),
) {
  const code = conversations.filter((c) => c.mode === "code");
  const today = dayStart(now);
  const cutoff =
    range === "all"
      ? -Infinity
      : today.getTime() - ((range === "30d" ? 30 : 7) - 1) * day;
  const inRange = (at: number) => at >= cutoff && at <= now;
  const turns = code.flatMap((c) =>
    c.turns.filter((t) => inRange(t.createdAt)),
  );
  const usage = entries(code).filter((e) => inRange(e.at));

  const models = new Map<string, { input: number; output: number }>();
  for (const e of usage) {
    const row = models.get(e.model) ?? { input: 0, output: 0 };
    row.input += e.input;
    row.output += e.output;
    models.set(e.model, row);
  }
  const tokens = usage.reduce((n, e) => n + e.input + e.output, 0);
  const byModel: ModelUsage[] = [...models]
    .map(([model, v]) => ({
      model,
      ...v,
      share: tokens ? (v.input + v.output) / tokens : 0,
    }))
    .filter((m) => m.input + m.output > 0)
    .sort((a, b) => b.share - a.share);

  const hours = Array.from({ length: 24 }, () => 0);
  for (const t of turns) hours[new Date(t.createdAt).getHours()]++;
  const peak = hours.indexOf(Math.max(...hours));

  // One bar per day: the range's days, or everything since the first activity.
  const first = usage.length
    ? dayStart(Math.min(...usage.map((e) => e.at)))
    : today;
  const count =
    range === "all"
      ? Math.round((today.getTime() - first.getTime()) / day) + 1
      : range === "30d"
        ? 30
        : 7;
  const daily: DayUsage[] = Array.from({ length: count }, (_, i) => {
    const date = new Date(today);
    date.setDate(date.getDate() - (count - 1 - i));
    return { date, byModel: {} };
  });
  for (const e of usage) {
    const index = daily.findIndex(
      (d) => d.date.getTime() === dayStart(e.at).getTime(),
    );
    if (index < 0) continue;
    daily[index].byModel[e.model] =
      (daily[index].byModel[e.model] ?? 0) + e.input + e.output;
  }

  return {
    sessions: code.filter((c) => c.turns.some((t) => inRange(t.createdAt)))
      .length,
    messages: turns.reduce(
      (n, t) => n + 1 + t.items.filter((i) => i.type === "agentMessage").length,
      0,
    ),
    tokens,
    activeDays: new Set(turns.map((t) => dayStart(t.createdAt).getTime())).size,
    peakHour: turns.length ? peak : undefined,
    favoriteModel: byModel[0]?.model,
    models: byModel,
    daily,
  };
}

/**
 * Messages per day over the last 26 weeks, for the activity grid. The last
 * week runs to its Saturday; days after today are `future` and get no tile.
 */
export function activityGrid(conversations: Conversation[], now = Date.now()) {
  const end = dayStart(now);
  end.setDate(end.getDate() + (6 - end.getDay()));
  const counts = new Map<number, number>();
  for (const c of conversations)
    if (c.mode === "code")
      for (const t of c.turns) {
        const key = dayStart(t.createdAt).getTime();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
  return Array.from({ length: 182 }, (_, i) => {
    const date = new Date(end);
    date.setDate(date.getDate() - (181 - i));
    return {
      date,
      count: counts.get(date.getTime()) ?? 0,
      future: date.getTime() > dayStart(now).getTime(),
    };
  });
}

/** A day's shade, 0 (none) to 4, against the busiest day of the window. */
export function heatLevel(count: number, max: number) {
  return count > 0 && max > 0 ? Math.ceil((count / max) * 4) : 0;
}

/** A heatmap tile's tooltip: "Oct 3 — 12". */
export const heatTip = (date: Date, count: number) =>
  `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} — ${count.toLocaleString("en-US")}`;

/** Compact token counts: 320.8k, 80.9M, 4k, 1.2B. */
export function compactTokens(n: number) {
  const unit = (value: number, suffix: string) =>
    `${value.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  if (n >= 1e9) return unit(n / 1e9, "B");
  if (n >= 1e6) {
    const m = Number((n / 1e6).toFixed(1));
    return m >= 1e3 ? unit(n / 1e9, "B") : unit(m, "M");
  }
  if (n >= 1e3) {
    const k = Number((n / 1e3).toFixed(1));
    return k >= 1e3 ? unit(n / 1e6, "M") : unit(k, "k");
  }
  return String(n);
}

/** The books the Overview compares a total with, by length in tokens. */
const books = [
  { title: "The Little Prince", tokens: 22_000 },
  { title: "Animal Farm", tokens: 39_000 },
  { title: "The Great Gatsby", tokens: 62_000 },
  { title: "Harry Potter and the Philosopher's Stone", tokens: 103_000 },
  { title: "The Hobbit", tokens: 123_000 },
  { title: "Pride and Prejudice", tokens: 156_000 },
  { title: "Dune", tokens: 244_000 },
  { title: "Moby-Dick", tokens: 268_000 },
  { title: "The Lord of the Rings", tokens: 576_000 },
  { title: "War and Peace", tokens: 730_000 },
];

/**
 * "You've used ~38× more tokens than The Great Gatsby." One of the books the
 * total reaches is picked at random, once per view (`roll`, 0 to 1); under
 * twice its length it reads "about as many tokens as". A total below the
 * shortest book names none.
 */
export function tokenComparison(tokens: number, roll = Math.random()) {
  const fits = books.filter((b) => tokens >= b.tokens);
  const book = fits[Math.min(fits.length - 1, Math.floor(roll * fits.length))];
  if (!book) return undefined;
  const times = Math.floor(tokens / book.tokens);
  return times >= 2
    ? formatText("You’ve used ~{times}× more tokens than {book}.", {
        times,
        book: book.title,
      })
    : formatText("You’ve used about as many tokens as {book}.", {
        book: book.title,
      });
}

/** The key of a day's tokens that the service reports without a model split. */
export const unsplit = "";

type CodeUsage = ReturnType<typeof codeUsage>;

/** `YYYY-MM-DD` of a local date. */
const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * A Sub2API account's card: tokens, models and the daily chart come from the
 * service's usage dashboard (every device and mode of the account, cache
 * tokens included); sessions, messages, active days and the peak hour stay
 * with this computer's conversations, which the service does not know.
 */
export function withDashboard(
  usage: CodeUsage,
  dashboard: CodeUsageDashboard,
): CodeUsage {
  const models: ModelUsage[] = dashboard.models.map((m) => ({
    model: m.model,
    input: m.input,
    output: m.output,
    share: dashboard.tokens ? m.total / dashboard.tokens : 0,
  }));
  const byDate = new Map(dashboard.daily.map((d) => [d.date, d.tokens]));
  // "All" starts at the service's first day with usage when that is earlier.
  const firstServiceDay = dashboard.daily.find((d) => d.tokens > 0)?.date;
  let days = usage.daily;
  if (
    firstServiceDay &&
    days.length &&
    dateKey(days[0].date) > firstServiceDay
  ) {
    const [y, m, d] = firstServiceDay.split("-").map(Number);
    const start = new Date(y, m - 1, d);
    const end = days.at(-1)!.date;
    const count = Math.round((end.getTime() - start.getTime()) / day) + 1;
    if (count > days.length && count <= 3660)
      days = Array.from({ length: count }, (_, i) => {
        const date = new Date(start);
        date.setDate(date.getDate() + i);
        return { date, byModel: {} };
      });
  }
  return {
    ...usage,
    tokens: dashboard.tokens,
    favoriteModel: models[0]?.model,
    models,
    daily: days.map(({ date }): DayUsage => {
      const tokens = byDate.get(dateKey(date)) ?? 0;
      return { date, byModel: tokens ? { [unsplit]: tokens } : {} };
    }),
  };
}
