/**
 * Plan usage windows from the Claudex service's `GET /claudex/usage-status`
 * (design 2.6, package C4): order, the window the weekly banner follows,
 * and how long the service keeps refusing. Pure, so the main process, the
 * fidelity fixture and the tests share it.
 */
import type {
  ClaudexUsageStatus,
  ClaudexUsageWindow,
} from "./claudex-contract";
import type { PlanUsageKind, PlanUsageWindow } from "./usage-api";

/** The order the service sends (design 2.6); used when two windows' order is otherwise unknown. */
const kindOrder: Record<PlanUsageKind, number> = {
  session: 0,
  all_models: 1,
  models: 2,
  daily: 3,
  monthly: 4,
  key: 5,
};

export function planUsageWindow(window: ClaudexUsageWindow): PlanUsageWindow {
  return {
    id: window.id,
    kind: window.kind,
    label: window.label,
    windowSeconds: window.windowSeconds > 0 ? window.windowSeconds : null,
    usedUsd: window.usedUsd,
    limitUsd: window.limitUsd,
    percent: Math.max(0, Math.min(100, window.percent)),
    // A window that has not started has no reset time yet.
    resetsAt: window.active ? window.resetsAt : null,
    active: window.active,
    exceeded: window.exceeded,
    models: window.models,
  };
}

/**
 * Windows grouped by kind in the service's order (session, weekly, per-model,
 * daily, monthly, device); within a kind the service's own order (rule
 * `sort_order`) is kept. Windows without a limit are left out.
 */
export function orderPlanWindows(windows: PlanUsageWindow[]) {
  return windows
    .map((window, index) => ({ window, index }))
    .filter(({ window }) => window.limitUsd > 0)
    .sort(
      (a, b) =>
        kindOrder[a.window.kind] - kindOrder[b.window.kind] ||
        a.index - b.index,
    )
    .map(({ window }) => window);
}

export function planWindowsFromStatus(status: ClaudexUsageStatus) {
  return orderPlanWindows(status.windows.map(planUsageWindow));
}

/**
 * The window the weekly banner follows: an all-models window (the
 * subscription's weekly cap or a weekly rule), the one closest to its limit
 * when there are several, since that one refuses first.
 */
export function bannerWindow(windows: PlanUsageWindow[]) {
  let best: PlanUsageWindow | undefined;
  for (const window of windows)
    if (
      window.kind === "all_models" &&
      window.limitUsd > 0 &&
      (!best ||
        Number(window.exceeded) - Number(best.exceeded) > 0 ||
        (window.exceeded === best.exceeded && window.percent > best.percent))
    )
      best = window;
  return best;
}

/**
 * When the service stops refusing: the reset of the window it names as
 * blocking, else the latest reset among exceeded windows; null when nothing
 * is exceeded or no reset is known.
 */
export function blockedUntil(status: ClaudexUsageStatus, now: number) {
  const blocked = status.blocked;
  if (blocked.blocked && blocked.resetsAt && blocked.resetsAt > now)
    return blocked.resetsAt;
  const resets = status.windows
    .filter((window) => window.exceeded && (window.resetsAt ?? 0) > now)
    .map((window) => window.resetsAt!);
  return resets.length ? Math.max(...resets) : null;
}
