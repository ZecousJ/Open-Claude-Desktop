import { currentLocale, t, tf } from "../i18n";

const minute = 60_000;
const hour = 60 * minute;

function startOfDay(timestamp: number) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Relative times as the History list shows them: "12 hours ago", "Yesterday",
 * "2 days ago" … "6 days ago", then "Sep 16"; a date in another year adds the
 * year.
 */
export function collectionTime(timestamp: number, now = Date.now()) {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < minute) return t("Just now");
  if (elapsed < hour) {
    const minutes = Math.floor(elapsed / minute);
    return tf(`{n} minute${minutes === 1 ? "" : "s"} ago`, { n: minutes });
  }
  const days = Math.round(
    (startOfDay(now) - startOfDay(timestamp)) / 86_400_000,
  );
  if (days === 0 || elapsed < 24 * hour) {
    const hours = Math.floor(elapsed / hour);
    return tf(`{n} hour${hours === 1 ? "" : "s"} ago`, { n: hours });
  }
  if (days === 1) return t("Yesterday");
  if (days < 7) return tf("{n} days ago", { n: days });
  const date = new Date(timestamp);
  return date.toLocaleDateString(currentLocale(), {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date(now).getFullYear()
      ? { year: "numeric" }
      : {}),
  });
}
