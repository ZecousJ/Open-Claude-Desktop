import type { WeeklyUsageStatus } from "../../shared/types";
import { currentLocale, formatText } from "../i18n";

export type BannerVariant = "code" | "chat";

/** "Mon, Sep 28, 5:00 PM" in the viewer's local time and the interface language, as in R-0338. */
export function formatReset(resetsAt: number) {
  return new Intl.DateTimeFormat(currentLocale(), {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetsAt));
}

/** Whether the banner is shown: at or over the operator's warning threshold and not closed. */
export function bannerVisible(status: WeeklyUsageStatus | null | undefined) {
  return !!status && status.state !== "ok" && !status.dismissed;
}

/**
 * Banner wording. Code names the limit and the reset; Chat and Cowork Give the
 * percent used. Once the limit is reached both say so plainly and give the
 * reset time, since requests are refused until then.
 */
export function bannerText(status: WeeklyUsageStatus, variant: BannerVariant) {
  const reset = formatText("Resets {when}", {
    when: formatReset(status.resetsAt),
  });
  // Sub2API refusals other than the weekly window.
  const reason = status.state === "exceeded" ? status.reason : undefined;
  if (reason === "daily" || reason === "monthly") {
    const period = reason === "daily" ? "daily" : "monthly";
    return variant === "code"
      ? {
          title: `${period[0].toUpperCase()}${period.slice(1)} usage limit reached`,
          detail: reset,
        }
      : { title: `You’ve reached your ${period} limit`, detail: reset };
  }
  if (reason === "key-quota")
    return { title: "This device has reached its usage cap" };
  if (reason === "balance") return { title: "Your balance is used up" };
  if (reason === "subscription") return { title: "Your plan is not active" };
  if (status.state === "exceeded")
    return variant === "code"
      ? { title: "Weekly usage limit reached", detail: reset }
      : { title: "You’ve reached your weekly limit", detail: reset };
  return variant === "code"
    ? { title: "Approaching weekly usage limit", detail: reset }
    : { title: `You’ve used ${status.percent}% of your weekly limit` };
}
