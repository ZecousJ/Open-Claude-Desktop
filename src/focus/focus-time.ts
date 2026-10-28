import type { QuietHours } from "../../shared/settings-extras";
import { formatText } from "../i18n";

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Whether `now` falls in the quiet hours. A range that crosses midnight
 * (22:00–07:00) belongs to the day it starts on, so Monday 23:00 and
 * Tuesday 06:00 both count for a Monday quiet night. Equal ends mean the
 * whole day.
 */
export function inQuietHours(quiet: QuietHours | undefined, now: Date) {
  if (!quiet?.days.length) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  const minute = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();
  if (start === end) return quiet.days.includes(day);
  if (start < end)
    return quiet.days.includes(day) && minute >= start && minute < end;
  // Crosses midnight: the evening of a chosen day, or the morning after it.
  if (minute >= start) return quiet.days.includes(day);
  if (minute < end) return quiet.days.includes((day + 6) % 7);
  return false;
}

/** When the current quiet period ends ("7:00 AM"), for the notice. */
export function quietEndLabel(quiet: QuietHours) {
  const [h, m] = quiet.end.split(":").map(Number);
  const date = new Date(2000, 0, 1, h, m);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "1 hr 30 min", "45 min" */
export function durationLabel(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} hr` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
}

/** The same in the interface language, for the break reminder's sentence. */
export function durationText(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [
    h ? formatText("{x} hr", { x: h }) : "",
    m ? formatText("{x} min", { x: m }) : "",
  ]
    .filter(Boolean)
    .join(" ");
}
