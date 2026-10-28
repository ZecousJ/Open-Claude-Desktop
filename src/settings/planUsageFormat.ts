/**
 * Wording of Settings → Usage: row labels, reset times, the headline and "Last
 * updated". Pure, so the wording is unit tested.
 */
import type { PlanUsageWindow } from "../../shared/types";
import { bannerWindow } from "../../shared/plan-usage";
import { currentLocale, t, formatText } from "../i18n";
import { usageSeverity } from "../composer/usage-meter";

/**
 * Settings search labels of the Usage page. Kept here rather than in
 * `tabs/Usage.tsx` so the search index does not load the page's stylesheet.
 */
export const searchLabels = [
  "Your usage",
  "Current session",
  "This week",
  "Last updated",
  "Learn more about usage limits",
  "See transaction history on the Billing page",
];

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const weekSeconds = 7 * 86_400;

const time = (at: number) =>
  new Intl.DateTimeFormat(currentLocale(), {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
const weekday = (at: number) =>
  new Intl.DateTimeFormat(currentLocale(), { weekday: "long" }).format(
    new Date(at),
  );
const date = (at: number) =>
  new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
  }).format(new Date(at));

const sameDay = (a: number, b: number) =>
  new Date(a).toDateString() === new Date(b).toDateString();

/**
 * "at 4:30 AM" the same day, "Monday 5:00 PM" within a week, "Oct 12, 9:00 AM"
 * a week or more away: the reset as a row's caption writes it.
 */
export function resetWhen(
  resetsAt: number,
  now: number,
  weekday: "short" | "long" = "long",
) {
  if (sameDay(resetsAt, now))
    return formatText("at {time}", { time: time(resetsAt) });
  return new Intl.DateTimeFormat(
    currentLocale(),
    resetsAt - now >= 7 * day
      ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { weekday, hour: "numeric", minute: "2-digit" },
  ).format(new Date(resetsAt));
}

/** "Resets at 4:30 AM", "Resets Monday 5:00 PM", "Resets Oct 12, 9:00 AM". */
export function resetText(
  resetsAt: number,
  now: number,
  weekday: "short" | "long" = "long",
) {
  return sameDay(resetsAt, now)
    ? formatText("Resets at {time}", { time: time(resetsAt) })
    : formatText("Resets {time}", {
        time: resetWhen(resetsAt, now, weekday),
      });
}

/** "weekly", "daily", "5-hour", "30-day": a window's length as an adjective. */
export function periodWord(seconds: number | null) {
  if (seconds === weekSeconds) return t("weekly");
  if (seconds === 86_400) return t("daily");
  if (!seconds) return t("usage");
  const hours = Math.round(seconds / 3600);
  return formatText(hours < 48 ? "{n}-hour" : "{n}-day", {
    n: new Intl.NumberFormat(currentLocale()).format(
      hours < 48 ? hours : Math.round(hours / 24),
    ),
  });
}

/**
 * The row's name, as the original's rows read: "Current session",
 * "This week", "Opus this week"; other windows keep the service's label.
 */
export function rowLabel(window: PlanUsageWindow) {
  const weekly = window.windowSeconds === weekSeconds;
  if (window.kind === "session") return t("Current session");
  if (window.kind === "all_models" && weekly) return t("This week");
  if (window.kind === "models" && weekly)
    return formatText("{model} this week", { model: window.label });
  return window.label;
}

/**
 * The line under the row: the reset, the session's with a short weekday; a
 * weekly per-model limit says it is separate ("Separate weekly limit for Opus ·
 * Resets Monday 5:00 PM"); a window that has not started says so.
 */
export function rowNote(window: PlanUsageWindow, now: number) {
  const reset =
    window.resetsAt === null
      ? null
      : resetText(
          window.resetsAt,
          now,
          window.kind === "session" ? "short" : "long",
        );
  if (window.kind === "models" && window.windowSeconds === weekSeconds)
    return reset
      ? formatText("Separate weekly limit for {scope} · {reset}", {
          scope: window.label,
          reset,
        })
      : formatText("Separate weekly limit for {scope}", {
          scope: window.label,
        });
  if (reset) return reset;
  return window.kind === "models"
    ? formatText("You haven’t used {scope} yet", { scope: window.label })
    : t("Starts with your first message");
}

/** "$1.20 of $5.00": Claudex plans are metered in US dollars. */
export function spendText(
  window: Pick<PlanUsageWindow, "usedUsd" | "limitUsd">,
) {
  return formatText("{used} of {limit}", {
    used: money(window.usedUsd),
    limit: money(window.limitUsd),
  });
}
export function money(value: number) {
  return new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** The bar and its percent turn red at the limit. */
export function atLimit(window: PlanUsageWindow) {
  return window.exceeded || window.percent >= 100;
}

/**
 * A row's colour: amber from 75%, red from 90% and at the limit, as the
 * composer's ring.
 */
export function rowSeverity(window: PlanUsageWindow) {
  return atLimit(window) ? "critical" : usageSeverity(window.percent);
}

/**
 * "Last updated: just now", "… less than a minute ago", "… 5 minutes ago", then
 * the time it was read once an hour has gone by.
 */
export function updatedText(updatedAt: number, now: number) {
  const seconds = (now - updatedAt) / 1000;
  if (seconds <= 0) return t("Last updated: just now");
  if (seconds < 60) return t("Last updated: less than a minute ago");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return formatText(
      minutes === 1
        ? "Last updated: {minutes} minute ago"
        : "Last updated: {minutes} minutes ago",
      { minutes: new Intl.NumberFormat(currentLocale()).format(minutes) },
    );
  return formatText("Last updated: {time}", { time: time(updatedAt) });
}

function limitName(window: PlanUsageWindow) {
  if (window.kind === "session") return t("session limit");
  if (window.kind === "daily") return t("daily limit");
  if (window.kind === "monthly") return t("monthly limit");
  if (window.kind === "models" || window.kind === "key")
    return formatText("{model} limit", { model: window.label });
  return formatText("{period} limit", {
    period: periodWord(window.windowSeconds),
  });
}

export type PaceState =
  "zero" | "fresh" | "early" | "on_track" | "heads_up" | "limit_hit";

/**
 * Where the week stands: at the limit, unused, under 10%, or under half a day
 * in; past that, the pace so far run on to the reset either stays under the
 * limit or runs out first, and when.
 */
export function weekPace(
  percent: number,
  resetsAt: number | null,
  now: number,
): { state: PaceState; percent: number; runsOutAt?: number } {
  const used = Number.isFinite(percent)
    ? Math.floor(Math.max(0, percent) + 1e-9)
    : 0;
  if (used >= 100) return { state: "limit_hit", percent: used };
  if (used === 0) return { state: "zero", percent: used };
  if (used < 10) return { state: "fresh", percent: used };
  const elapsed = resetsAt === null ? null : now - (resetsAt - 7 * day);
  if (resetsAt === null || elapsed === null || elapsed < 12 * hour)
    return { state: "early", percent: used };
  const runsOutAt = now + ((100 - used) * elapsed) / used;
  return runsOutAt < resetsAt
    ? { state: "heads_up", percent: used, runsOutAt }
    : { state: "on_track", percent: used };
}

const dayNumber = (at: number) => {
  const date = new Date(at);
  return Math.round(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / day,
  );
};
/** Before 5 AM belongs to the night before, unless that is before today. */
const nightOf = (at: number, now: number) => {
  if (new Date(at).getHours() >= 5) return at;
  const before = at - 5 * hour;
  return dayNumber(before) < dayNumber(now) ? at : before;
};
const dayOf = (at: number, now: number) => {
  const gap = dayNumber(at) - dayNumber(now);
  return gap === 0 ? "today" : gap === 1 ? "tomorrow" : "other";
};
const partOf = (at: number) => {
  const hours = new Date(at).getHours();
  return hours < 5
    ? "night"
    : hours < 12
      ? "morning"
      : hours < 17
        ? "afternoon"
        : hours < 21
          ? "evening"
          : "night";
};

/** "this afternoon", "tomorrow night", "Thursday morning". */
function runOutWhen(at: number, now: number) {
  const part = partOf(at);
  const anchor = nightOf(at, now);
  const when = dayOf(anchor, now);
  if (when === "today")
    return t(
      part === "morning"
        ? "this morning"
        : part === "afternoon"
          ? "this afternoon"
          : part === "evening"
            ? "this evening"
            : "tonight",
    );
  if (when === "tomorrow")
    return t(
      part === "morning"
        ? "tomorrow morning"
        : part === "afternoon"
          ? "tomorrow afternoon"
          : part === "evening"
            ? "tomorrow evening"
            : "tomorrow night",
    );
  return formatText(
    part === "morning"
      ? "{weekday} morning"
      : part === "afternoon"
        ? "{weekday} afternoon"
        : part === "evening"
          ? "{weekday} evening"
          : "{weekday} night",
    { weekday: weekday(anchor) },
  );
}

/** The week's reset as the headline names it. */
function resetKind(resetsAt: number, now: number, runsOutAt?: number) {
  if (
    runsOutAt !== undefined &&
    dayNumber(nightOf(runsOutAt, now)) === dayNumber(resetsAt)
  )
    return { kind: "time" as const, value: time(resetsAt) };
  if (resetsAt - now >= 6 * day)
    return { kind: "date" as const, value: date(resetsAt) };
  const when = dayOf(resetsAt, now);
  return when === "other"
    ? { kind: "weekday" as const, value: weekday(resetsAt) }
    : { kind: when, value: "" };
}

/** "Monday 5:00 PM PDT", "Oct 12, 5:00 PM PDT". */
function weekResets(resetsAt: number, now: number) {
  return new Intl.DateTimeFormat(currentLocale(), {
    ...(resetsAt - now >= 6 * day
      ? { month: "short", day: "numeric" }
      : { weekday: "long" }),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  } as Intl.DateTimeFormatOptions).format(new Date(resetsAt));
}

function paceText(
  pace: ReturnType<typeof weekPace>,
  resetsAt: number | null,
  now: number,
) {
  const percent = new Intl.NumberFormat(currentLocale()).format(pace.percent);
  const reset =
    resetsAt === null ? null : resetKind(resetsAt, now, pace.runsOutAt);
  switch (pace.state) {
    case "zero":
      return t("No usage yet. 100% of your weekly limit is available.");
    case "fresh":
      return formatText("Fresh week. {percent}% of your weekly limit used.", {
        percent,
      });
    case "early":
      return formatText("{percent}% of your weekly limit used.", { percent });
    case "on_track":
      return !reset
        ? t("On track. You have room to spare this week.")
        : reset.kind === "today"
          ? t("On track. You should reach today’s reset with room to spare.")
          : reset.kind === "tomorrow"
            ? t(
                "On track. You should reach tomorrow’s reset with room to spare.",
              )
            : reset.kind === "weekday"
              ? formatText(
                  "On track. You should reach {weekday}’s reset with room to spare.",
                  { weekday: reset.value },
                )
              : reset.kind === "date"
                ? formatText(
                    "On track. You should reach the {date} reset with room to spare.",
                    { date: reset.value },
                  )
                : t("On track. You have room to spare this week.");
    case "heads_up": {
      const runOut = runOutWhen(pace.runsOutAt!, now);
      return !reset
        ? formatText("Heads up. At this pace you’ll run out {runOut}.", {
            runOut,
          })
        : reset.kind === "today"
          ? formatText(
              "Heads up. At this pace you’ll run out {runOut}, before today’s reset.",
              { runOut },
            )
          : reset.kind === "tomorrow"
            ? formatText(
                "Heads up. At this pace you’ll run out {runOut}, before tomorrow’s reset.",
                { runOut },
              )
            : reset.kind === "weekday"
              ? formatText(
                  "Heads up. At this pace you’ll run out {runOut}, before {weekday}’s reset.",
                  { runOut, weekday: reset.value },
                )
              : reset.kind === "date"
                ? formatText(
                    "Heads up. At this pace you’ll run out {runOut}, before the {date} reset.",
                    { runOut, date: reset.value },
                  )
                : formatText(
                    "Heads up. At this pace you’ll run out {runOut}, before the {time} reset.",
                    { runOut, time: reset.value },
                  );
    }
    case "limit_hit":
      return resetsAt === null
        ? t("Limit hit. You can send new messages when your week resets.")
        : formatText(
            "Limit hit. You can send new messages when your week resets {reset}.",
            { reset: weekResets(resetsAt, now) },
          );
  }
}

/**
 * The page's headline and where the week stands: the weekly window over all
 * models by the original's pace states. A plan without a weekly window: a
 * refused window first ("You’ve hit your session limit. It resets at 9:30
 * AM."), else that window's use. Null with no window over all models.
 */
export function pace(
  windows: PlanUsageWindow[],
  now: number,
): { state: PaceState | null; text: string } | null {
  const main = bannerWindow(windows);
  if (main && main.windowSeconds === weekSeconds) {
    const resetsAt = main.resetsAt;
    const state = weekPace(main.exceeded ? 100 : main.percent, resetsAt, now);
    return { state: state.state, text: paceText(state, resetsAt, now) };
  }
  const refused = windows
    .filter((window) => window.exceeded && window.resetsAt !== null)
    .sort((a, b) => b.resetsAt! - a.resetsAt!)[0];
  if (refused)
    return {
      state: "limit_hit",
      text: formatText("You’ve hit your {limit}. It resets {when}.", {
        limit: limitName(refused),
        when: resetWhen(refused.resetsAt!, now),
      }),
    };
  if (!main) return null;
  return {
    state: null,
    text: formatText("{percent}% of your {period} limit used.", {
      percent: new Intl.NumberFormat(currentLocale()).format(
        Math.round(main.percent),
      ),
      period: periodWord(main.windowSeconds),
    }),
  };
}

/** The headline's words alone. */
export function headline(windows: PlanUsageWindow[], now: number) {
  return pace(windows, now)?.text ?? null;
}
