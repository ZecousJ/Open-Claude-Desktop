/**
 * Five-field cron expressions with an optional CRON_TZ or TZ prefix
 * (desktop bundle 2.31226.1: numeric fields only, 0 for Sunday, and no
 * schedule that runs more than once an hour). A field is `*`, a number, a
 * range `a-b` or a list `a,b`, each optionally followed by a step `/n`;
 * names (MON, JAN) and the `? L W #` symbols are not supported.
 */

export type CronProblem =
  "invalid" | "subHourly" | "numericOnly" | "sundayIsZero" | "unknownZone";

/** The original's wording for each problem, shown under the field. */
export const cronProblemMessages: Record<CronProblem, string> = {
  invalid:
    "Invalid cron expression. Check the format (for example: 0 9 * * *).",
  subHourly: "Schedules must run at most once per hour.",
  numericOnly:
    "Use numeric fields only (for example 1 for Monday). Named days/months and the ? L W # symbols aren’t supported here.",
  sundayIsZero: "Use 0 for Sunday (7 isn’t supported here).",
  unknownZone: "This time zone isn’t recognized. Check the name after CRON_TZ=",
};

export interface Cron {
  timeZone?: string;
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

function readCron(
  expression: string,
  allowSubHourly = false,
): Cron | CronProblem {
  const parts = expression.trim().split(/\s+/);
  const prefix = /^(?:CRON_TZ|TZ)=(.*)$/.exec(parts[0]);
  let timeZone: string | undefined;
  if (prefix) {
    parts.shift();
    timeZone = prefix[1];
    if (!/^[A-Za-z]/.test(timeZone)) return "unknownZone";
    try {
      new Intl.DateTimeFormat("en", { timeZone });
    } catch {
      return "unknownZone";
    }
  }
  if (parts.length !== 5) return "invalid";
  if (parts.some((part) => /[A-Za-z?]|[#]/.test(part))) return "numericOnly";
  // 7 is Sunday in some crons; here only 0 is.
  if (
    parts[4]
      .split(",")
      .some((part) => part.split("/")[0].split("-").includes("7"))
  )
    return "sundayIsZero";
  const fields: number[][] = [];
  for (const [index, part] of parts.entries()) {
    const values = field(part, bounds[index]);
    if (!values?.length) return "invalid";
    fields.push(values);
  }
  const [minutes, hours, days, months, weekdays] = fields;
  if (!allowSubHourly && minutes.length > 1) return "subHourly";
  return {
    ...(timeZone === undefined ? {} : { timeZone }),
    minutes,
    hours,
    days,
    months,
    weekdays,
    anyDay: parts[2].startsWith("*"),
    anyWeekday: parts[4].startsWith("*"),
  };
}

/** What is wrong with an expression, or undefined when a routine can use it. */
export function cronProblem(expression: string): CronProblem | undefined {
  const result = readCron(expression);
  return typeof result === "string" ? result : undefined;
}

/** The values an expression matches; throws what `cronProblem` reports. */
export function parseCron(expression: string, allowSubHourly = false): Cron {
  const result = readCron(expression, allowSubHourly);
  if (typeof result === "string") throw new Error(cronProblemMessages[result]);
  return result;
}

function matchesDay(cron: Cron, month: number, day: number, weekday: number) {
  if (!cron.months.includes(month)) return false;
  const inMonth = cron.days.includes(day);
  const onWeekday = cron.weekdays.includes(weekday);
  return !cron.anyDay && !cron.anyWeekday
    ? inMonth || onWeekday
    : inMonth && onWeekday;
}

const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;
const searchDays = 366 * 8;

function wallTimeAt(formatter: Intl.DateTimeFormat, at: number): number {
  const { year, month, day, hour, minute } = Object.fromEntries(
    formatter.formatToParts(at).map(({ type, value }) => [type, Number(value)]),
  );
  return Date.UTC(year, month - 1, day, hour, minute);
}

function nextZonedCron(cron: Cron, after: number, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  const start = Math.floor(after / dayMs) * dayMs;
  for (let day = start; day <= start + searchDays * dayMs; day += dayMs) {
    const end = day + dayMs;
    const offsets = new Set([
      wallTimeAt(formatter, day) - day,
      wallTimeAt(formatter, end) - end,
    ]);
    let next = Infinity;
    for (const offset of offsets) {
      const wallEnd = end + offset;
      const wallStart = Math.floor((day + offset) / dayMs) * dayMs;
      for (let wallDay = wallStart; wallDay < wallEnd; wallDay += dayMs) {
        const date = new Date(wallDay);
        if (
          !matchesDay(
            cron,
            date.getUTCMonth() + 1,
            date.getUTCDate(),
            date.getUTCDay(),
          )
        )
          continue;
        for (const hour of cron.hours)
          for (const minute of cron.minutes) {
            const wall = wallDay + (hour * 60 + minute) * minuteMs;
            const at = wall - offset;
            // Only real wall times match. An offset change can give a time zero or two instants.
            if (
              at >= day &&
              at < end &&
              at > after &&
              at < next &&
              wallTimeAt(formatter, at) === wall
            )
              next = at;
          }
      }
    }
    if (next < Infinity) return next;
  }
  return undefined;
}

/** The first matching minute strictly after `after`, in the named or local time zone. */
export function nextCron(
  expression: string,
  after: number,
  allowSubHourly = false,
): number | undefined {
  const cron = parseCron(expression, allowSubHourly);
  if (cron.timeZone) return nextZonedCron(cron, after, cron.timeZone);
  const start = new Date(after);
  for (let offset = 0; offset <= searchDays; offset++) {
    const day = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + offset,
    );
    if (!matchesDay(cron, day.getMonth() + 1, day.getDate(), day.getDay()))
      continue;
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
 * schedule; undefined for an explicit time zone or a more complex rule.
 */
export function cronAsDays(expression: string) {
  const cron = readCron(expression);
  if (
    typeof cron === "string" ||
    cron.timeZone ||
    cron.minutes.length !== 1 ||
    cron.hours.length !== 1 ||
    !cron.anyDay ||
    cron.months.length !== 12
  )
    return undefined;
  const time = `${String(cron.hours[0]).padStart(2, "0")}:${String(cron.minutes[0]).padStart(2, "0")}`;
  return { time, days: cron.weekdays };
}
