/**
 * Plan usage as the Code footer's ring and its popover show it: which window
 * the ring follows, how full reads as a colour, when a window resets, and token
 * counts as the usage report writes them. Pure, so the wording is unit tested;
 * the ring loads it with the footer, so it stays small.
 */
import type { PlanUsage, PlanUsageWindow } from "../../shared/usage-api";
import { currentLocale, formatText } from "../i18n";

/** The ring's and the popover's plan usage: loading, failed, or read (null: no plan). */
export type PlanUsageState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; usage: PlanUsage | null };

export type UsageSeverity = "normal" | "warning" | "critical";

/** The live meters turn amber from 75% and red from 90%. */
export function usageSeverity(percent: number): UsageSeverity {
  return percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal";
}

/** A window's percent as the meters draw it: a refusing window is full. */
export function windowPercent(window: PlanUsageWindow) {
  return window.exceeded ? 100 : Math.max(0, Math.min(100, window.percent));
}

/**
 * The window the ring follows when it shows plan usage: the fullest window
 * over all models (live: the most used window that applies to the model;
 * Claudex's per-model rules name patterns the footer cannot match, so they
 * are only listed in the popover).
 */
export function ringWindow(windows: PlanUsageWindow[]) {
  let best: PlanUsageWindow | undefined;
  for (const window of windows)
    if (
      window.models === null &&
      (!best || windowPercent(window) > windowPercent(best))
    )
      best = window;
  return best;
}

const minute = 60_000;

/**
 * When a window resets, as the live meters say it: "Resets in 25 min",
 * "Resets in 3 hr 5 min" within a day, else "Resets Mon 5:00 PM" (a week
 * or more away: "Resets Oct 20, 5:00 PM"). Null once the time has passed
 * or while the window has not started.
 */
export function resetIn(resetsAt: number | null, now: number) {
  if (resetsAt === null || resetsAt <= now) return null;
  const at = Math.round(resetsAt / minute) * minute;
  const minutes = Math.floor(Math.max(0, at - now) / minute);
  if (minutes < 60) return formatText("Resets in {minutes} min", { minutes });
  if (minutes < 1440)
    return formatText("Resets in {hours} hr {minutes} min", {
      hours: Math.floor(minutes / 60),
      minutes: minutes % 60,
    });
  const time = new Intl.DateTimeFormat(
    currentLocale(),
    minutes >= 10080
      ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { weekday: "short", hour: "numeric", minute: "2-digit" },
  ).format(new Date(at));
  return formatText("Resets {time}", { time });
}

/**
 * The ring's tooltip in plan usage, as the live one: "42% of session limit",
 * else the window's own name ("Weekly: 42%").
 */
export function planRingLabel(window: PlanUsageWindow) {
  const pct = Math.round(windowPercent(window));
  return window.kind === "session"
    ? formatText("{pct}% of session limit", { pct })
    : formatText("{limit}: {pct}%", { limit: window.label, pct });
}

/** The ring's accessible name in plan usage: "Usage: 42% of session limit, Resets in 3 hr 5 min". */
export function planRingName(label: string, reset: string | null) {
  return formatText("Usage: {parts}", {
    parts: reset ? `${label}, ${reset}` : label,
  });
}

/** Token counts as the live usage report writes them: 950, 12.3k, 4M. */
export function tokenCount(value: number) {
  const short = (n: number, unit: string) =>
    `${n.toFixed(1).replace(/\.0$/, "")}${unit}`;
  if (value >= 1e9) return short(value / 1e9, "B");
  if (value >= 1e6) {
    const n = Number((value / 1e6).toFixed(1));
    return n >= 1e3 ? short(value / 1e9, "B") : short(n, "M");
  }
  if (value >= 1e3) {
    const n = Number((value / 1e3).toFixed(1));
    return n >= 1e3 ? short(value / 1e6, "M") : short(n, "k");
  }
  return String(value);
}
