import { useEffect, useRef, useState } from "react";
import type { Settings } from "../../shared/types";
import { preference } from "../../shared/settings-extras";
import { InfoCircleIcon } from "../policy/policy-icons";
import { CloseSmallIcon } from "../ui/icons";
import { durationText, inQuietHours, quietEndLabel } from "./focus-time";
import { formatText, useT } from "../i18n";
import { useNoticeStack } from "../ui/notice-stack";
import "./focus.css";

/** Away this long (window hidden or unfocused) counts as a break. */
const breakGapMs = 5 * 60_000;
const tickMs = 30_000;
export const snoozeMinutes = 15;

/**
 * Settings → Time and focus. A corner notice, in the app's toast box, when the
 * set time of use in a row has passed (Snooze adds 15 minutes, dismissing
 * starts the count again), and once per quiet period while it lasts. Nothing is
 * blocked.
 */
export function FocusNotices({ settings }: { settings: Settings }) {
  const t = useT();
  const limit = preference(settings, "breakReminderMinutes");
  const quiet = preference(settings, "quietHours");
  const used = useRef(0);
  const lastTick = useRef(Date.now());
  const away = useRef<number | undefined>(undefined);
  const [due, setDue] = useState<number>();
  const [snoozedUntil, setSnoozedUntil] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [dismissedQuiet, setDismissedQuiet] = useState<string>();
  const notice = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tick = () => {
      const at = Date.now();
      const active =
        document.visibilityState === "visible" && document.hasFocus();
      if (active) {
        if (away.current !== undefined && at - away.current >= breakGapMs)
          used.current = 0;
        away.current = undefined;
        used.current += Math.min(at - lastTick.current, tickMs * 2);
      } else if (away.current === undefined) away.current = at;
      lastTick.current = at;
      setNow(new Date(at));
      if (limit > 0 && used.current >= limit * 60_000 && at >= snoozedUntil)
        setDue(Math.round(used.current / 60_000));
    };
    const timer = window.setInterval(tick, tickMs);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    window.addEventListener("blur", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
      window.removeEventListener("blur", tick);
    };
  }, [limit, snoozedUntil]);

  // The quiet period this notice belongs to: its day and settings.
  const quietKey = `${now.toDateString()}:${quiet.start}-${quiet.end}`;
  const quietNow = inQuietHours(quiet, now) && dismissedQuiet !== quietKey;

  const shown = (due !== undefined && limit > 0) || quietNow;
  useNoticeStack(notice, shown);
  if (due !== undefined && limit > 0)
    return (
      <div ref={notice} className="toast focus-toast" role="status">
        <InfoCircleIcon size={20} />
        <span className="toast-text">
          {formatText(
            "You’ve been using Claudex for {duration}. Time for a short break?",
            { duration: durationText(due) },
          )}
          <span className="focus-toast-actions">
            <button
              type="button"
              onClick={() => {
                setSnoozedUntil(Date.now() + snoozeMinutes * 60_000);
                setDue(undefined);
              }}
            >
              {formatText("Snooze {minutes} min", { minutes: snoozeMinutes })}
            </button>
          </span>
        </span>
        <button
          type="button"
          className="toast-close"
          aria-label={t("Dismiss")}
          onClick={() => {
            used.current = 0;
            setDue(undefined);
          }}
        >
          <CloseSmallIcon />
        </button>
      </div>
    );
  if (quietNow)
    return (
      <div ref={notice} className="toast focus-toast" role="status">
        <InfoCircleIcon size={20} />
        <span className="toast-text">
          {formatText(
            "It’s your quiet hours until {time}. You set this time limit in Settings → Time and focus.",
            { time: quietEndLabel(quiet) },
          )}
        </span>
        <button
          type="button"
          className="toast-close"
          aria-label={t("Dismiss")}
          onClick={() => setDismissedQuiet(quietKey)}
        >
          <CloseSmallIcon />
        </button>
      </div>
    );
  return null;
}
