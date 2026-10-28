import { currentLocale } from "../i18n";

/** "Sep 26", with the year when it is not this year's. */
export function shareDate(at: number, now = Date.now()) {
  const date = new Date(at);
  const year = date.getFullYear() !== new Date(now).getFullYear();
  return date.toLocaleDateString(currentLocale(), {
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
  });
}
