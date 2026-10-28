import { currentLocale, formatText } from "../../i18n";
import type {
  StorageCleanupKind,
  StorageCleanupResult,
  StorageUsage,
} from "../../../shared/settings-desktop-api";

/**
 * The words of Settings → System → Storage and its cleanups, one English
 * sentence per count form so each translates whole.
 */

const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

/**
 * A size as the storage dialog writes it ("1.2 GB", "0 bytes"): decimal units,
 * one decimal.
 */
export function storageSize(bytes: number, locale = currentLocale()): string {
  const step = 1000;
  const index =
    bytes < step
      ? 0
      : Math.min(
          units.length - 1,
          Math.floor(Math.log(bytes) / Math.log(step)),
        );
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[index],
    unitDisplay: index === 0 ? "long" : "short",
    maximumFractionDigits: index === 0 ? 0 : 1,
  }).format(bytes / step ** index);
}

const counted = (
  count: number,
  one: string,
  other: string,
  values: Record<string, string | number> = {},
) => formatText(count === 1 ? one : other, { ...values, count });

/** The areas' sizes as the bar shows them. */
export function storageAreas(usage: StorageUsage) {
  const { cowork, code, runtime, app } = usage;
  return {
    cowork:
      cowork.historyBytes +
      cowork.filesBytes +
      cowork.pluginsAndSkillsBytes +
      cowork.workspaceBytes +
      cowork.otherBytes,
    code: code.historyBytes + code.scratchBytes,
    runtime: runtime.bytes,
    app:
      app.webCacheBytes +
      app.browserPanesBytes +
      app.logsBytes +
      app.otherCachesBytes,
  };
}

/** Cowork tasks' row: how many, and how many went quiet. */
export function coworkSummary(usage: StorageUsage): string {
  const { count, chatCount, stale } = usage.cowork;
  const total =
    chatCount > 0
      ? counted(count, "{count} task or chat.", "{count} tasks and chats.")
      : counted(count, "{count} task.", "{count} tasks.");
  const quiet =
    stale.count > 0
      ? counted(
          stale.count,
          "{count} has had no activity in the last {days} days ({size}).",
          "{count} have had no activity in the last {days} days ({size}).",
          { days: stale.olderThanDays, size: storageSize(stale.bytes) },
        )
      : formatText("All active in the last {days} days.", {
          days: stale.olderThanDays,
        });
  return joined(total, quiet);
}

/** Two sentences one after the other (no space between them in Chinese or Japanese). */
const joined = (first: string, second: string) =>
  formatText("{first} {second}", { first, second });

/** Code's row: Claudex makes no worktrees, so only the sessions. */
export function codeSummary(usage: StorageUsage): string {
  return counted(
    usage.code.sessionCount,
    "{count} session.",
    "{count} sessions.",
  );
}

/** Runtime's row: the agent runtimes downloaded for SSH hosts. */
export function runtimeSummary(usage: StorageUsage): string {
  const versions = usage.runtime.versionCount;
  return versions === 0
    ? "Codex downloads."
    : counted(
        versions,
        "{count} downloaded Codex version.",
        "{count} downloaded Codex versions.",
      );
}

/** The confirming button of a cleanup. */
export function confirmLabel(
  kind: StorageCleanupKind,
  count: number,
  chatCount: number,
  deleteSessions: boolean,
): string {
  if (kind === "code") {
    if (!deleteSessions) return "Remove";
    return count === 0
      ? "Delete"
      : counted(count, "Delete {count} session", "Delete {count} sessions");
  }
  if (count === 0) return "Delete";
  return chatCount > 0
    ? counted(
        count,
        "Delete {count} task or chat",
        "Delete {count} tasks and chats",
      )
    : counted(count, "Delete {count} task", "Delete {count} tasks");
}

/** What Free up space… found: "12 inactive tasks and chats · 1.2 GB". */
export function coworkFound(
  count: number,
  chatCount: number,
  size: string,
): string {
  return chatCount > 0
    ? counted(
        count,
        "{count} inactive task or chat · {size}",
        "{count} inactive tasks and chats · {size}",
        { size },
      )
    : counted(
        count,
        "{count} inactive task · {size}",
        "{count} inactive tasks · {size}",
        { size },
      );
}

/** Why Free up space… has nothing to delete. */
export function coworkNothing(unverifiedCount: number, days: number): string {
  return unverifiedCount > 0
    ? counted(
        unverifiedCount,
        "{count} task looks inactive but changed on this computer in the last {days} days (recently copied or restored, for example), so nothing can be freed yet.",
        "{count} tasks look inactive but changed on this computer in the last {days} days (recently copied or restored, for example), so nothing can be freed yet.",
        { days },
      )
    : formatText(
        "Nothing has been inactive for {days} days, so there is nothing to delete.",
        { days },
      );
}

/** Clean up inactive sessions' summary when none has a worktree (Claudex makes none). */
export function codeFound(count: number): string {
  return count === 1
    ? "The inactive session no longer has a worktree"
    : formatText("None of the {count} inactive sessions still has a worktree", {
        count,
      });
}

export function deleteSessionsLabel(count: number): string {
  return count === 1
    ? "Also delete the inactive session and its conversation"
    : formatText(
        "Also delete the {count} inactive sessions and their conversations",
        { count },
      );
}

/**
 * The notices after a cleanup ran (Tt, Et, Dt, Bt, Ut, Wt in the live
 * bundle): what was deleted or kept, and what failed.
 */
export function cleanupNotices(
  kind: StorageCleanupKind,
  chats: boolean,
  result: StorageCleanupResult,
): { success?: string; error?: string } {
  const notices: { success?: string; error?: string } = {};
  const deleted = result.deletedCount;
  // Code without deleting the sessions: the worktrees removed.
  if (kind === "code" && result.worktreesRemoved !== undefined) {
    notices.success = counted(
      result.worktreesRemoved,
      "Removed {count} worktree.",
      "Removed {count} worktrees.",
    );
    if (result.failedCount > 0)
      notices.error = counted(
        result.failedCount,
        "{count} worktree couldn’t be removed.",
        "{count} worktrees couldn’t be removed.",
      );
    return notices;
  }
  if (kind === "code") {
    if (result.cancelled)
      notices.success =
        deleted === 0
          ? "Stopped before deleting anything."
          : counted(
              deleted,
              "Stopped after deleting {count} session.",
              "Stopped after deleting {count} sessions.",
            );
    else if (deleted > 0 || result.failedCount === 0) {
      const done = counted(
        deleted,
        "Deleted {count} session.",
        "Deleted {count} sessions.",
      );
      notices.success =
        result.skippedCount > 0
          ? joined(
              done,
              counted(
                result.skippedCount,
                "{count} was left as it is (in use, pinned, or changed since).",
                "{count} were left as they are (in use, pinned, or changed since).",
              ),
            )
          : done;
    }
    if (!result.cancelled && result.failedCount > 0)
      notices.error = counted(
        result.failedCount,
        "{count} session couldn’t be deleted.",
        "{count} sessions couldn’t be deleted.",
      );
    return notices;
  }
  if (result.cancelled)
    notices.success =
      deleted === 0
        ? "Stopped before deleting anything."
        : chats
          ? counted(
              deleted,
              "Stopped after deleting {count} task or chat.",
              "Stopped after deleting {count} tasks and chats.",
            )
          : counted(
              deleted,
              "Stopped after deleting {count} task.",
              "Stopped after deleting {count} tasks.",
            );
  else if (deleted > 0 || result.failedCount === 0) {
    const done = chats
      ? counted(
          deleted,
          "Deleted {count} task or chat",
          "Deleted {count} tasks and chats",
        )
      : counted(deleted, "Deleted {count} task", "Deleted {count} tasks");
    const skipped = result.skippedCount;
    notices.success =
      skipped === 0
        ? formatText("{deleted}.", { deleted: done })
        : formatText(
            skipped === 1
              ? "{deleted}; {skipped} was kept."
              : "{deleted}; {skipped} were kept.",
            { deleted: done, skipped },
          );
  }
  if (!result.cancelled && result.failedCount > 0) {
    const failed = result.failedCount;
    const inUse = result.failedInUseCount === failed;
    notices.error = chats
      ? inUse
        ? counted(
            failed,
            "{count} task or chat couldn’t be deleted because files in it are in use.",
            "{count} tasks and chats couldn’t be deleted because files in them are in use.",
          )
        : counted(
            failed,
            "{count} task or chat couldn’t be deleted.",
            "{count} tasks and chats couldn’t be deleted.",
          )
      : inUse
        ? counted(
            failed,
            "{count} task couldn’t be deleted because files in it are in use.",
            "{count} tasks couldn’t be deleted because files in them are in use.",
          )
        : counted(
            failed,
            "{count} task couldn’t be deleted.",
            "{count} tasks couldn’t be deleted.",
          );
  }
  return notices;
}
