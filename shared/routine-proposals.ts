import { parseTime, timeOf } from "./routines";
import type { RoutineRepeat } from "./routines";

/** What `/schedule <description>` proposes before anything is saved. */
export interface ScheduleProposal {
  name: string;
  prompt: string;
  repeat: RoutineRepeat;
}

const dayWords: [RegExp, number][] = [
  [/\bsun(day)?s?\b/i, 0],
  [/\bmon(day)?s?\b/i, 1],
  [/\btue(s|sday)?s?\b/i, 2],
  [/\bwed(nesday)?s?\b/i, 3],
  [/\bthu(r|rs|rsday)?s?\b/i, 4],
  [/\bfri(day)?s?\b/i, 5],
  [/\bsat(urday)?s?\b/i, 6],
];

/** "at 9", "9am", "9:30 pm", "14:05", "noon", "midnight"; undefined when absent. */
function clockIn(text: string): string | undefined {
  if (/\bnoon\b/i.test(text)) return "12:00";
  if (/\bmidnight\b/i.test(text)) return "00:00";
  const match =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?=\s|$|[,.;!?])/i.exec(
      text,
    ) ??
    /\bat\s+(\d{1,2})(?::(\d{2}))?\b/i.exec(text) ??
    /\b(\d{1,2}):(\d{2})\b/.exec(text);
  if (!match) return undefined;
  let hours = +match[1];
  const minutes = match[2] ? +match[2] : 0;
  const suffix = match[3]?.toLowerCase().replace(/\./g, "");
  if (suffix && (hours < 1 || hours > 12)) return undefined;
  if (suffix === "pm" && hours < 12) hours += 12;
  if (suffix === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

const monthWords = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const countWords: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
};

/** A phrase that runs the task a single time. */
const onceWords =
  /\b(once|one[- ]time|just once|tomorrow|today|tonight|in\s+(?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty)\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?)|on\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2})\b/i;

/** Words that make a schedule repeat, whatever else the description says. */
const repeatWords =
  /\b(every|each|daily|weekly|hourly|weekdays?|monthly|nightly|work ?day|business days?)\b/i;

/**
 * The moment a description names for a single run ("tomorrow at 3pm", "in 2
 * hours", "on Oct 14 at 9", "once on Friday at 4pm"), in the computer's local
 * time and strictly after `now`; undefined when it asks for no single run or
 * the moment has passed.
 */
export function onceIn(text: string, now: number): number | undefined {
  if (repeatWords.test(text) || !onceWords.test(text)) return undefined;
  const clock = clockIn(text);
  const at = (date: Date, time: string | undefined, fallback: string) => {
    const { hours, minutes } = parseTime(time ?? fallback)!;
    date.setHours(hours, minutes, 0, 0);
    return date.getTime();
  };
  const result = (() => {
    const relative =
      /\bin\s+(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i.exec(
        text,
      );
    if (relative) {
      const count = /^\d+$/.test(relative[1])
        ? +relative[1]
        : countWords[relative[1].toLowerCase()];
      const unit = relative[2].toLowerCase();
      if (unit.startsWith("m")) return now + count * 60_000;
      if (unit.startsWith("h")) return now + count * 3_600_000;
      const date = new Date(now);
      date.setDate(date.getDate() + count * (unit.startsWith("w") ? 7 : 1));
      return at(date, clock, timeOf(now));
    }
    const named =
      /\bon\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(
        text,
      );
    if (named) {
      const date = new Date(now);
      date.setMonth(monthWords.indexOf(named[1].toLowerCase()), +named[2]);
      let moment = at(date, clock, "09:00");
      // A date already gone this year means next year's.
      if (moment <= now) {
        date.setFullYear(date.getFullYear() + 1);
        moment = at(date, clock, "09:00");
      }
      return moment;
    }
    if (/\btomorrow\b/i.test(text)) {
      const date = new Date(now);
      date.setDate(date.getDate() + 1);
      return at(date, clock, "09:00");
    }
    if (/\btonight\b/i.test(text)) return at(new Date(now), clock, "20:00");
    if (/\btoday\b/i.test(text)) return at(new Date(now), clock, "17:00");
    // "once on Friday at 4pm": the next such day.
    const days = dayWords.filter(([pattern]) => pattern.test(text));
    if (days.length === 1) {
      for (let offset = 0; offset <= 7; offset++) {
        const date = new Date(now);
        date.setDate(date.getDate() + offset);
        if (date.getDay() !== days[0][1]) continue;
        const moment = at(date, clock, "09:00");
        if (moment > now) return moment;
      }
    }
    return undefined;
  })();
  if (result === undefined) return undefined;
  const moment = Math.floor(result / 60_000) * 60_000;
  return moment > now ? moment : undefined;
}

/**
 * Reads the schedule out of a `/schedule` description ("every weekday at
 * 9am check CI"): hourly, weekdays, one or more named days, weekly or
 * daily, at the time given (9:00 AM otherwise), or a single run at a named
 * moment ("tomorrow at 3pm"). The whole description becomes the routine's
 * instructions; the confirmation card lets the person change every field
 * before anything is saved.
 */
export function proposeSchedule(
  description: string,
  now = Date.now(),
): ScheduleProposal {
  const text = description.trim().replace(/\s+/g, " ");
  if (!text) throw new Error("Describe what the routine should do.");
  const time = clockIn(text) ?? "09:00";
  let repeat: RoutineRepeat;
  const single = onceIn(text, now);
  if (single !== undefined) repeat = { kind: "once", at: single };
  else if (/\b(hourly|every hour|each hour)\b/i.test(text)) {
    const minute = /\b(?:at\s+)?:(\d{2})\b/.exec(text);
    repeat = { kind: "hourly", minute: minute ? Math.min(59, +minute[1]) : 0 };
  } else if (
    /\b(monthly|every month|each month|of (?:every|each|the) month)\b/i.test(
      text,
    )
  ) {
    const day =
      /\b(?:on\s+(?:the\s+)?|day\s+)(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(text);
    repeat = {
      kind: "monthly",
      time,
      dayOfMonth: day ? Math.max(1, Math.min(31, Number(day[1]))) : 1,
    };
  } else if (/\b(weekdays?|every work ?day|business days?)\b/i.test(text))
    repeat = { kind: "weekdays", time };
  else {
    const days = dayWords
      .filter(([pattern]) => pattern.test(text))
      .map(([, day]) => day);
    repeat =
      days.length === 1
        ? { kind: "weekly", time, day: days[0] }
        : days.length > 1
          ? { kind: "custom", time, days }
          : /\b(weekly|every week|each week)\b/i.test(text)
            ? { kind: "weekly", time, day: 1 }
            : { kind: "daily", time };
  }
  // The name is what the routine does, without when it runs.
  const words = text
    .replace(
      /\b(?:in\s+(?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty)\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?)|on\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|tomorrow|today|tonight|once|one[- ]time|just once)\b/gi,
      " ",
    )
    .replace(
      /\b(every|each|on|at)\s+(work ?day|weekday|week|day|hour|morning|evening|night)s?\b/gi,
      " ",
    )
    .replace(
      /\b(on\s+|every\s+|each\s+)?(sun|mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?)(day)?s?\b(\s+and\b)?/gi,
      " ",
    )
    .replace(
      /\b(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?(?=\s|$|[,.;!?])/gi,
      " ",
    )
    .replace(
      /\b(hourly|daily|weekly|weekdays|at noon|at midnight|noon|midnight)\b/gi,
      " ",
    )
    .replace(/^\s*(at|on|and)\b/i, " ")
    .replace(/[^\p{L}\p{N}\s'’-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  while (
    words.length > 1 &&
    /^(and|or|the|a|an|to|of|for|with|what|that)$/i.test(words.at(-1)!)
  )
    words.pop();
  const name = words.join(" ");
  return {
    name: name ? name[0].toUpperCase() + name.slice(1, 120) : "Routine",
    prompt: text.slice(0, 100_000),
    repeat,
  };
}
