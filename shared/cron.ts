/**
 * The five-field cron expressions a routine's Custom schedule takes. A field
 * is `*`, a number, a range `a-b` or a list `a,b`, each optionally followed by
 * a step `/n`; names (MON, JAN) and the `? L W #` symbols are not supported.
 */

export type CronProblem =
  "invalid" | "subHourly" | "numericOnly" | "sundayIsZero";

/** The original's wording for each problem, shown under the field. */
export const cronProblemMessages: Record<CronProblem, string> = {
  invalid:
    "Invalid cron expression. Check the format (for example: 0 9 * * *).",
  subHourly: "Schedules must run at most once per hour.",
  numericOnly:
    "Use numeric fields only (for example 1 for Monday). Named days/months and the ? L W # symbols aren’t supported here.",
  sundayIsZero: "Use 0 for Sunday (7 isn’t supported here).",
};

export interface Cron {
  minutes: number[];
  hours: number[];
  /** Days of the month, months (1-12) and weekdays (0 = Sunday) that match. */
  days: number[];
  months: number[];
  weekdays: number[];
  /** Whether the day-of-month / weekday field was `*`: both set means either matches. */
  anyDay: boolean;
  anyWeekday: boolean;
}

const bounds = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

/** One field's values, or undefined when it is malformed or out of range. */
function field(text: string, [min, max]: readonly [number, number]) {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) return undefined;
    const step = match[2] === undefined ? 1 : +match[2];
    if (step < 1) return undefined;
    let from = min;
    let to = max;
    if (match[1] !== "*") {
      const [low, high] = match[1].split("-").map(Number);
      from = low;
      // "5/10" runs from 5 to the end; a plain "5" is just 5.
      to = high ?? (match[2] === undefined ? low : max);
    }
    if (from < min || to > max || from > to) return undefined;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** What is wrong with an expression, or undefined when a routine can use it. */
export function cronProblem(expression: string): CronProblem | undefined {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return "invalid";
  if (parts.some((part) => /[A-Za-z?]|[#]/.test(part))) return "numericOnly";
  // 7 is Sunday in some crons; here only 0 is.
  if (
    parts[4]
      .split(",")
      .some((part) => part.split("/")[0].split("-").includes("7"))
  )
    return "sundayIsZero";
  const parsed = parts.map((part, index) => field(part, bounds[index]));
  if (parsed.some((values) => !values?.length)) return "invalid";
  if (parsed[0]!.length > 1) return "subHourly";
  return undefined;
}

/** The values an expression matches; throws what `cronProblem` reports. */
export function parseCron(expression: string, allowSubHourly = false): Cron {
  const problem = cronProblem(expression);
  if (problem && !(allowSubHourly && problem === "subHourly"))
    throw new Error(cronProblemMessages[problem]);
  const parts = expression.trim().split(/\s+/);
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) =>
    field(part, bounds[index])!,
  );
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    anyDay: parts[2].startsWith("*"),
    anyWeekday: parts[4].startsWith("*"),
  };
}

/** The first matching minute strictly after `after`, in local time; undefined if none within about eight years. */
export function nextCron(
  expression: string,
  after: number,
  allowSubHourly = false,
): number | undefined {
  const cron = parseCron(expression, allowSubHourly);
  const start = new Date(after);
  for (let offset = 0; offset <= 366 * 8; offset++) {
    const day = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + offset,
    );
    if (!cron.months.includes(day.getMonth() + 1)) continue;
    const inMonth = cron.days.includes(day.getDate());
    const onWeekday = cron.weekdays.includes(day.getDay());
    // Cron: when both day fields are restricted, either one matches.
    const matches =
      !cron.anyDay && !cron.anyWeekday
        ? inMonth || onWeekday
        : inMonth && onWeekday;
    if (!matches) continue;
    for (const hour of cron.hours)
      for (const minute of cron.minutes) {
        const at = new Date(
          day.getFullYear(),
          day.getMonth(),
          day.getDate(),
          hour,
          minute,
        ).getTime();
        if (at > after) return at;
      }
  }
  return undefined;
}

/** "M H * * d,d" for a time of day on some weekdays (Sunday = 0). */
export function cronForDays(time: string, days: number[]) {
  const [hours, minutes] = time.split(":").map(Number);
  const list = [...new Set(days)].sort((a, b) => a - b);
  return `${minutes} ${hours} * * ${list.length === 7 || !list.length ? "*" : list.join(",")}`;
}

/**
 * A simple expression read back as a time of day on some weekdays (every
 * day when the weekday field is `*`), so it can be worded like any other
 * schedule; undefined for anything that fires more often or on dates.
 */
export function cronAsDays(expression: string) {
  if (cronProblem(expression)) return undefined;
  const cron = parseCron(expression);
  if (
    cron.minutes.length !== 1 ||
    cron.hours.length !== 1 ||
    !cron.anyDay ||
    cron.months.length !== 12
  )
    return undefined;
  const time = `${String(cron.hours[0]).padStart(2, "0")}:${String(cron.minutes[0]).padStart(2, "0")}`;
  return { time, days: cron.weekdays };
}
