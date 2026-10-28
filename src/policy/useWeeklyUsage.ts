import { useEffect, useState } from "react";
import type { WeeklyUsageStatus } from "../../shared/types";

/**
 * The account's usage status for the usage notices: loaded once, then
 * followed through the main process's "weekly-usage" events after each turn,
 * and loaded again when the window resets so the notice clears on time.
 */
export function useWeeklyUsage() {
  const [status, setStatus] = useState<WeeklyUsageStatus | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.resolve(window.desktop.weeklyUsageStatus?.())
        .then((value) => live && setStatus(value ?? null))
        // An unreadable policy or usage log shows no notice.
        .catch(() => live && setStatus(null));
    void load();
    const off = window.desktop.onEvent((event) => {
      if (event.type === "weekly-usage") setStatus(event.status);
      // The account changed (a new balance or plan): read it again.
      else if (event.type === "service-changed") void load();
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  useEffect(() => {
    if (!status) return;
    const wait = Math.min(status.resetsAt - Date.now() + 1000, 2 ** 31 - 1);
    const timer = setTimeout(
      () => {
        void Promise.resolve(window.desktop.weeklyUsageStatus?.())
          .then((value) => setStatus(value ?? null))
          .catch(() => setStatus(null));
      },
      Math.max(wait, 1000),
    );
    return () => clearTimeout(timer);
  }, [status]);
  /** Closes the notice; `seen` is the state it showed. */
  const dismiss = () => {
    if (!status) return;
    setStatus({ ...status, dismissed: true });
    void Promise.resolve(window.desktop.dismissWeeklyUsage?.(status.state))
      .then((value) => setStatus(value ?? null))
      .catch(() => {});
  };
  return { status, dismiss };
}
