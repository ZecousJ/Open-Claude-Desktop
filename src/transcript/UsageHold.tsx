import { useEffect, useState } from "react";
import type { Mode, Turn, WeeklyUsageStatus } from "../../shared/types";
import { currentLocale, formatText, t } from "../i18n";
import { ReplyBanner, waitingForResponse } from "./ReplyBanner";
import { replyIsEmpty } from "./TurnOutcome";

export function usageHoldMessage(
  turn: Turn,
  latest: boolean,
  held: boolean,
  resetsAt: number | null,
  now = Date.now(),
) {
  if (!latest) return t("Paused when your usage limit was reached.");
  if (!held)
    return replyIsEmpty(turn)
      ? t("Stopped by a usage limit. You can try again now.")
      : t(
          "Paused when your usage limit was reached. Continue to pick up where Claudex stopped.",
        );
  if (resetsAt === null)
    return t("Paused: Your usage limit was reached. Continue once it resets.");
  const reset = new Date(resetsAt);
  const time = new Intl.DateTimeFormat(currentLocale(), {
    hour: "numeric",
    minute: "2-digit",
  }).format(reset);
  return formatText(
    reset.toDateString() === new Date(now).toDateString()
      ? "Paused: Your usage limit resets at {time}. Continue then."
      : "Paused: Your usage limit resets {day} at {time}. Continue then.",
    {
      time,
      day: new Intl.DateTimeFormat(currentLocale(), {
        month: "short",
        day: "numeric",
      }).format(reset),
    },
  );
}

// Usage-stop notices.
export function UsageHold({
  turn,
  mode,
  latest,
  busy,
  onContinue,
  onRetry,
}: {
  turn: Turn;
  mode: Mode;
  latest: boolean;
  busy: boolean;
  onContinue: () => void;
  onRetry: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [status, setStatus] = useState<WeeklyUsageStatus | null>();
  useEffect(() => {
    if (!latest) return;
    let live = true;
    const load = () =>
      void Promise.resolve(window.desktop.weeklyUsageStatus?.())
        .then((value) => {
          if (live) setStatus(value ?? null);
        })
        .catch(() => {});
    load();
    const off = window.desktop.onEvent((event) => {
      if (event.type === "weekly-usage") setStatus(event.status);
      else if (event.type === "service-changed") load();
    });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const refresh = setInterval(load, 30000);
    return () => {
      live = false;
      off();
      clearInterval(timer);
      clearInterval(refresh);
    };
  }, [latest]);
  const resetsAt = status?.globalLimit
    ? status.globalLimit.resetsAt
    : status?.state === "exceeded"
      ? status.resetsAt
      : (turn.usageHold?.resetsAt ?? null);
  const held =
    !status?.globalLimit &&
    (status?.state === "ok" || status?.state === "warning")
      ? false
      : resetsAt === null || resetsAt > now;
  const empty = replyIsEmpty(turn);
  return (
    <ReplyBanner
      mode={mode}
      disabledReason={
        busy ? waitingForResponse : held ? t("Usage limit reached") : undefined
      }
      buttons={
        latest
          ? [
              {
                label: empty && !held ? t("Try again") : t("Continue"),
                onClick: empty ? onRetry : onContinue,
              },
            ]
          : []
      }
    >
      {usageHoldMessage(turn, latest, held, resetsAt, now)}
    </ReplyBanner>
  );
}
