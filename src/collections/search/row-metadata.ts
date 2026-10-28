import type { Approval, Conversation } from "../../../shared/types";
import type { Routine } from "../../../shared/routines";
import { repeatLabel, repeatOf } from "../../../shared/routine-labels";
import { currentLocale, formatText, t } from "../../i18n";
import { isRunning } from "../../conversation/unread";

/** Palette status is read from live turns/requests, not guessed from a title. */
export function searchConversationState(
  c: Conversation,
  approvals: readonly Approval[] = [],
) {
  if (approvals.some((a) => a.conversationId === c.id))
    return { kind: "awaiting", label: t("Awaiting input") };
  return isRunning(c) ? { kind: "running", label: t("Running") } : undefined;
}

/** Keep the scheduler's clock formatting; translate its fixed recurrence words. */
export function searchScheduleLabel(task: Routine) {
  const rule = repeatOf(task),
    locale = currentLocale(),
    raw = repeatLabel(rule, locale);
  if (locale.startsWith("en")) return raw;
  let m: RegExpMatchArray | null;
  if ((m = raw.match(/^Daily at (.+)$/)))
    return formatText("Daily at {time}", { time: m[1] });
  if ((m = raw.match(/^Weekdays at (.+)$/)))
    return formatText("Weekdays at {time}", { time: m[1] });
  if ((m = raw.match(/^Hourly at (.+)$/)))
    return formatText("Hourly at {time}", { time: m[1] });
  if ((m = raw.match(/^Once on (.+)$/)))
    return formatText("Once on {date}", { date: m[1] });
  if (raw === "Manual") return t("Manual");
  if ((m = raw.match(/^Cron (.+)$/)))
    return formatText("Cron {expression}", { expression: m[1] });
  const day = (value: number) =>
    new Intl.DateTimeFormat(locale, {
      weekday: "long",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(2026, 9, 11 + value)));
  if ((m = raw.match(/^Every .+ at (.+)$/))) {
    const value =
      rule.kind === "weekly"
        ? rule.day
        : rule.kind === "custom"
          ? rule.days[0]
          : undefined;
    if (value !== undefined)
      return formatText("Every {day} at {time}", {
        day: day(value),
        time: m[1],
      });
  }
  if ((m = raw.match(/^At (.+), on day (\d+) of the month$/)))
    return formatText("At {time}, on day {day} of the month", {
      time: m[1],
      day: m[2],
    });
  if (rule.kind === "custom" && (m = raw.match(/^At ([^,]+), (.+)$/)))
    return formatText("At {time}, {days}", {
      time: m[1],
      days: new Intl.ListFormat(locale, {
        style: "long",
        type: "conjunction",
      }).format([...new Set(rule.days)].sort((a, b) => a - b).map(day)),
    });
  return raw;
}
export function searchRoutineRunLabel(
  task: Pick<Routine, "runCount" | "runCountLimited">,
) {
  const count = task.runCount;
  if (count === undefined || !Number.isSafeInteger(count) || count <= 0)
    return undefined;
  if (task.runCountLimited) return formatText("{count}+ runs", { count });
  return count === 1 ? t("1 run") : formatText("{count} runs", { count });
}
