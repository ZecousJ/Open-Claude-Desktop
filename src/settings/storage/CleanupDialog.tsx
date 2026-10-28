import { useEffect, useRef, useState } from "react";
import { Spinner } from "../../ui/Spinner";
import { formatText, t, useT } from "../../i18n";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Skeleton, SkeletonGroup } from "../../ui/Skeleton";
import { showToast } from "../../ui/toast-store";
import { SettingsModal } from "../controls";
import type {
  StorageCleanupKind,
  StorageCleanupPreview,
  StorageCleanupWindow,
} from "../../../shared/settings-desktop-api";
import {
  cleanupNotices,
  codeFound,
  confirmLabel,
  coworkFound,
  coworkNothing,
  deleteSessionsLabel,
  storageSize,
} from "./storage-text";

type Preview =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; preview: StorageCleanupPreview };

const windows: StorageCleanupWindow[] = [30, 60, 90];

/** The run's notice when it can't start. */
const errorNotice = (code: string) =>
  code === "already-running"
    ? "A cleanup is still finishing. Try again in a moment."
    : "Cleanup isn’t available right now.";

/**
 * Free up space… and Clean up inactive sessions…: pick how long inactive, see
 * how many and how much, tick that it can't be undone, then delete, with
 * progress and Stop. Clean up inactive sessions removes the inactive sessions'
 * worktrees (their uncommitted work with them; the sessions stay), or, with
 * "Also delete…" ticked, deletes the sessions and their worktrees.
 */
export function CleanupDialog({
  kind,
  onClose,
  onDone,
}: {
  kind: StorageCleanupKind;
  onClose: () => void;
  /** Something was deleted: measure again. */
  onDone: () => void;
}) {
  useT();
  const [days, setDays] = useState<StorageCleanupWindow>(30);
  const [state, setState] = useState<Preview>({ status: "loading" });
  const [acknowledged, setAcknowledged] = useState(false);
  const [deleteSessions, setDeleteSessions] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const request = useRef(0);
  const running = useRef(false);
  const load = (range: StorageCleanupWindow) => {
    const id = ++request.current;
    setState({ status: "loading" });
    setAcknowledged(false);
    window.desktop.previewStorageCleanup(kind, range).then(
      (result) => {
        if (id !== request.current) return;
        if (result.preview)
          setState({ status: "ready", preview: result.preview });
        else setState({ status: "error" });
      },
      () => {
        if (id === request.current) setState({ status: "error" });
      },
    );
  };
  useEffect(() => {
    load(30);
    const off = window.desktop.onEvent((event) => {
      if (event.type === "storage-cleanup-progress" && running.current)
        setProgress({ done: event.done, total: event.total });
    });
    return () => {
      request.current++;
      off();
      // Closing the window part-way stops the run after its current deletion.
      if (running.current) void window.desktop.cancelStorageCleanup();
    };
  }, []);
  const preview = state.status === "ready" ? state.preview : null;
  const code = kind === "code";
  const working = progress !== null;
  // What the confirming button acts on.
  const count = !preview
    ? 0
    : code && !deleteSessions
      ? (preview.worktreeCount ?? 0)
      : preview.count;
  const anything = Boolean(preview && preview.count > 0);
  const acknowledgeLabel = code
    ? deleteSessions
      ? "I understand deleted conversations can’t be recovered"
      : null
    : "I understand this can’t be undone";
  const ready = count > 0 && (acknowledged || acknowledgeLabel === null);
  const close = () => {
    if (!working) onClose();
  };
  const confirm = async () => {
    if (!preview || !ready || working) return;
    running.current = true;
    setProgress({ done: 0, total: count });
    try {
      const result = await window.desktop.runStorageCleanup(
        preview.token,
        code ? { deleteSessions } : undefined,
      );
      running.current = false;
      if (result.errorCode === "expired") {
        // Too old or replaced: look again.
        setProgress(null);
        load(days);
        return;
      }
      if (result.errorCode) {
        showToast(t(errorNotice(result.errorCode)));
        setProgress(null);
        return;
      }
      const notices = cleanupNotices(kind, preview.chatCount > 0, result);
      if (notices.success) showToast(notices.success);
      if (notices.error) showToast(notices.error);
      onClose();
      onDone();
    } catch {
      running.current = false;
      showToast(t("Cleanup didn’t finish. Try again."));
      setProgress(null);
      onDone();
    }
  };
  const verb = code && !deleteSessions ? "remove" : "delete";
  return (
    <SettingsModal
      title={code ? "Clean up inactive sessions" : "Free up space"}
      variant="confirm"
      // The disabled Delete can't hold focus: Cancel starts with it, as
      // the live dialog's initialFocus.
      confirmFocus="cancel"
      className="storage-cleanup"
      onClose={close}
    >
      <div className="storage-cleanup-body" aria-busy={!preview || undefined}>
        <SegmentedControl
          className="settings-segmented storage-window"
          label={t("Inactive for at least")}
          value={String(days)}
          disabled={working}
          segments={windows.map((value) => ({
            value: String(value),
            label: formatText("{days} days", { days: value }),
          }))}
          onChange={(value) => {
            const next = Number(value) as StorageCleanupWindow;
            setDays(next);
            load(next);
          }}
        />
        {state.status === "loading" && (
          <div className="storage-cleanup-loading">
            {code && <p>Checking inactive sessions…</p>}
            <SkeletonGroup>
              <Skeleton height={20} width="75%" />
              <Skeleton height={20} width="50%" />
            </SkeletonGroup>
          </div>
        )}
        {state.status === "error" && (
          <p className="storage-cleanup-text">
            Couldn’t work out what to clean up. Try again.
          </p>
        )}
        {preview && !anything && (
          <p className="storage-cleanup-text">
            {code
              ? formatText(
                  "No Code session has been inactive for {days} days.",
                  {
                    days: preview.olderThanDays,
                  },
                )
              : coworkNothing(preview.unverifiedCount, preview.olderThanDays)}
          </p>
        )}
        {preview && anything && (
          <>
            {code && !deleteSessions && (
              <p className="storage-cleanup-text">
                {(preview.worktreeCount ?? 0) === 0
                  ? t("None of them has a worktree left on disk.")
                  : (preview.worktreeCount ?? 0) === 1
                    ? t(
                        "Removes 1 worktree. Uncommitted work in it is discarded; the session and its branch stay.",
                      )
                    : formatText(
                        "Removes {count} worktrees. Uncommitted work in them is discarded; the sessions and their branches stay.",
                        { count: preview.worktreeCount ?? 0 },
                      )}
              </p>
            )}
            <p className="storage-cleanup-summary">
              {code
                ? codeFound(preview.count)
                : coworkFound(
                    preview.count,
                    preview.chatCount,
                    storageSize(preview.bytes),
                  )}
            </p>
            {preview.examples.length > 0 && (
              <ul className="storage-cleanup-examples" data-no-translate>
                {preview.examples.map((example, index) => (
                  <li key={index}>
                    {code
                      ? formatText("{title} · {size}", {
                          title: example.title || t("Untitled"),
                          size: storageSize(example.bytes),
                        })
                      : example.title}
                  </li>
                ))}
                {preview.count > preview.examples.length && (
                  <li>
                    {formatText("and {count} more", {
                      count: preview.count - preview.examples.length,
                    })}
                  </li>
                )}
              </ul>
            )}
            {code && (
              <label className="storage-check">
                <input
                  type="checkbox"
                  className="cx-check-input"
                  checked={deleteSessions}
                  disabled={working}
                  onChange={(event) => {
                    setDeleteSessions(event.target.checked);
                    setAcknowledged(false);
                  }}
                />
                <span>{deleteSessionsLabel(preview.count)}</span>
              </label>
            )}
            {acknowledgeLabel && (
              <label className="storage-check">
                <input
                  type="checkbox"
                  className="cx-check-input"
                  checked={acknowledged}
                  disabled={working}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>{acknowledgeLabel}</span>
              </label>
            )}
          </>
        )}
      </div>
      {progress && (
        <>
          <p className="storage-cleanup-progress" aria-hidden="true">
            {formatText(
              verb === "remove"
                ? "Removing {done} of {total}…"
                : "Deleting {done} of {total}…",
              { done: progress.done, total: progress.total },
            )}
          </p>
          <p role="status" className="sr-only">
            {formatText(
              verb === "remove"
                ? "Removing {done} of {total}…"
                : "Deleting {done} of {total}…",
              {
                // Announced in tenths, not at every step.
                done: Math.min(
                  progress.done,
                  Math.floor(
                    (Math.floor(
                      (progress.done * 10) / Math.max(progress.total, 1),
                    ) *
                      progress.total) /
                      10,
                  ),
                ),
                total: progress.total,
              },
            )}
          </p>
        </>
      )}
      <div className="button-row">
        {working ? (
          <button
            type="button"
            className="secondary"
            onClick={() => void window.desktop.cancelStorageCleanup()}
          >
            Stop
          </button>
        ) : (
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className={`primary ${
            code && !deleteSessions ? "" : "danger-button"
          } ${working ? "busy" : ""}`}
          disabled={!ready || working}
          aria-busy={working || undefined}
          aria-label={
            working
              ? t(verb === "remove" ? "Removing…" : "Deleting…")
              : undefined
          }
          onKeyDown={(event) => {
            // A held key doesn't confirm again.
            if (event.repeat && (event.key === "Enter" || event.key === " "))
              event.preventDefault();
          }}
          onClick={() => void confirm()}
        >
          <span className="busy-label">
            {confirmLabel(kind, count, preview?.chatCount ?? 0, deleteSessions)}
          </span>
          {working && <Spinner inheritColor size="sm" className="spin" />}
        </button>
      </div>
    </SettingsModal>
  );
}
