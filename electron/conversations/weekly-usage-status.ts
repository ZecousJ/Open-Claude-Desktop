import fs from "node:fs";
import path from "node:path";
import { resolveRequestLimits } from "../../server/operator-limits";
import { UsageLedger } from "./usage-ledger";
import {
  isDismissed,
  parseDismissal,
  weeklyUsageStatus,
  weeklyWindow,
  type WeeklyDismissal,
} from "./weekly-usage";
import type { WeeklyUsageStatus } from "../../shared/types";

/** Where the account remembers that it closed this week's banner. */
const dismissalFile = (profileRoot: string) =>
  path.join(profileRoot, "weekly-usage-banner.json");

export function readDismissal(
  profileRoot: string,
): WeeklyDismissal | undefined {
  try {
    return parseDismissal(
      JSON.parse(fs.readFileSync(dismissalFile(profileRoot), "utf8")),
    );
  } catch {
    return undefined;
  }
}

/**
 * The account's weekly usage from its own usage log, against the operator's
 * current policy in `<dataRoot>/backend/limits.json`.
 */
export function readWeeklyUsage(
  dataRoot: string,
  accountId: string,
  profileRoot: string,
  now = Date.now(),
): WeeklyUsageStatus | null {
  const limits = resolveRequestLimits(dataRoot, accountId);
  if (limits.weeklyTokenLimit === null) return null;
  const { start } = weeklyWindow(
    now,
    limits.weeklyResetDay,
    limits.weeklyResetHour,
  );
  const used = new UsageLedger(profileRoot).tokens(start, now);
  return weeklyUsageStatus(limits, used, now, readDismissal(profileRoot));
}

/**
 * Closes the banner until the next reset, or until usage becomes exceeded.
 * `seen` is the state the person closed; a warning they closed while usage
 * had meanwhile become exceeded does not hide the exceeded banner.
 */
export function dismissWeeklyUsage(
  dataRoot: string,
  accountId: string,
  profileRoot: string,
  now = Date.now(),
  seen: WeeklyUsageStatus["state"] = "exceeded",
): WeeklyUsageStatus | null {
  return saveDismissal(
    profileRoot,
    readWeeklyUsage(dataRoot, accountId, profileRoot, now),
    seen,
  );
}

/** Records that `status`, shown as `seen`, was closed; shared by the local and Sub2API sources. */
export function saveDismissal(
  profileRoot: string,
  status: WeeklyUsageStatus | null,
  seen: WeeklyUsageStatus["state"],
): WeeklyUsageStatus | null {
  if (!status) return null;
  const filename = dismissalFile(profileRoot),
    temporary = `${filename}.tmp`;
  const value: WeeklyDismissal = {
    resetsAt: status.resetsAt,
    exceeded: status.state === "exceeded" && seen === "exceeded",
  };
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, filename);
  return {
    ...status,
    dismissed: isDismissed(value, status.resetsAt, status.state),
  };
}
