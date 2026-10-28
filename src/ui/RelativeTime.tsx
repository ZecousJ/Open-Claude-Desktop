import { useEffect, useState } from "react";
import { currentLocale, t, useLocale } from "../i18n";
import { WithTooltip } from "./Tooltip";

/** From this age on a time reads as a date: 168 hours, a week. */
const ABSOLUTE_AFTER_SECONDS = 168 * 3600;

/**
 * A moment as the original's relative time writes it: "just now" under a
 * minute, then minutes, hours and days rounded to the nearest, "yesterday" for
 * one day (the locale's own words), and from a week on a short date, with the
 * year only when it is not this one ("Oct 5", "Oct 5, 2025").
 */
export function relativeTime(
  createdAt: number,
  now = Date.now(),
  absoluteAfterSeconds = ABSOLUTE_AFTER_SECONDS,
  relativeFormat: Intl.RelativeTimeFormatStyle = "long",
) {
  const elapsed = Math.round((now - createdAt) / 1000);
  if (!Number.isFinite(elapsed)) return "";
  // A clock a little ahead of the server's reads as now, not as the future.
  const seconds = Math.max(0, elapsed);
  if (seconds < 60)
    return relativeFormat === "long"
      ? t("just now")
      : new Intl.RelativeTimeFormat(currentLocale(), {
          numeric: "auto",
          style: relativeFormat,
        }).format(0, "second");
  const locale = currentLocale();
  if (seconds >= absoluteAfterSeconds)
    return new Date(createdAt).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      year:
        new Date(createdAt).getFullYear() === new Date(now).getFullYear()
          ? undefined
          : "numeric",
    });
  const [size, unit] =
    seconds >= 86400
      ? ([86400, "day"] as const)
      : seconds >= 3600
        ? ([3600, "hour"] as const)
        : ([60, "minute"] as const);
  return new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: relativeFormat,
  }).format(-Math.round(seconds / size), unit);
}

/** The full date and time the tooltip shows (the original's, with the time zone). */
export function fullTime(createdAt: number) {
  return new Date(createdAt).toLocaleString(currentLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** The original refreshes every relative time once a minute. */
const REFRESH_MS = 60000;

export function RelativeTime({
  createdAt,
  className = "reply-time",
  absoluteAfterSeconds,
  relativeFormat,
}: {
  createdAt: number;
  className?: string;
  absoluteAfterSeconds?: number;
  relativeFormat?: Intl.RelativeTimeFormatStyle;
}) {
  useLocale();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(timer);
  }, [createdAt]);
  if (!Number.isFinite(createdAt)) return null;
  return (
    <WithTooltip label={fullTime(createdAt)} placement="above">
      {(tooltip) => (
        <span className={className} {...tooltip}>
          {relativeTime(createdAt, now, absoluteAfterSeconds, relativeFormat)}
        </span>
      )}
    </WithTooltip>
  );
}
