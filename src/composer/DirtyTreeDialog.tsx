import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "../ui/glyphs";
import type {
  FolderChanges,
  FolderChangesAction,
} from "../../shared/code-usage-api";
import { formatText, t } from "../i18n";
import { Modal } from "../ui/Controls";
import { Menu, type MenuPosition } from "../ui/Menu";
import "./dirty-tree.css";

const labels: Record<FolderChangesAction, string> = {
  stash: "Stash changes",
  commit: "Commit as WIP",
  discard: "Discard changes",
};

/**
 * Uncommitted changes on {branch}: the folder has changes and another branch
 * was chosen. Cancel, or a split button whose menu picks Stash changes (the
 * default), Commit as WIP or Discard changes; Discard asks again ("Discard
 * uncommitted changes?", Back or a red Discard). The changed files are counted
 * under the question, and other running sessions in the folder are warned
 * about.
 */
export default function DirtyTreeDialog({
  folder,
  currentBranch,
  targetBranch,
  otherSessions,
  onResolve,
  onClose,
}: {
  folder: string;
  currentBranch: string;
  targetBranch: string;
  /** Running sessions in the folder, which the switch affects too. */
  otherSessions: number;
  /** Clears the changes; true when it worked (the caller switches then). */
  onResolve: (action: FolderChangesAction) => Promise<boolean>;
  onClose: () => void;
}) {
  const [action, setAction] = useState<FolderChangesAction>("stash");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState<FolderChangesAction | null>(null);
  const [failed, setFailed] = useState(false);
  const [changes, setChanges] = useState<FolderChanges | null>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const more = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve(window.desktop?.folderChanges?.(folder))
      .then((value) => live && setChanges(value ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [folder]);
  const run = async (chosen: FolderChangesAction) => {
    setBusy(chosen);
    setFailed(false);
    const ok = await onResolve(chosen).catch(() => false);
    setBusy(null);
    setConfirmDiscard(false);
    if (!ok) setFailed(true);
  };
  const close = () => {
    if (busy) return;
    if (confirmDiscard) setConfirmDiscard(false);
    else onClose();
  };
  return createPortal(
    <Modal
      title={
        confirmDiscard
          ? t("Discard uncommitted changes?")
          : formatText("Uncommitted changes on {currentBranch}", {
              currentBranch,
            })
      }
      onClose={close}
      variant="confirm"
      confirmFocus="cancel"
      className="dirty-tree"
    >
      {confirmDiscard ? (
        <p className="confirm-body">
          {formatText(
            "All uncommitted changes on {currentBranch} will be permanently lost.",
            { currentBranch },
          )}
        </p>
      ) : (
        <div className="confirm-body dirty-tree-body">
          <p>
            {formatText("Handle them before switching to {targetBranch}.", {
              targetBranch,
            })}
          </p>
          {otherSessions > 0 && (
            <p>
              {otherSessions === 1
                ? t(
                    "1 other session is using this folder. Switching branches will affect it too.",
                  )
                : formatText(
                    "{count} other sessions are using this folder. Switching branches will affect them too.",
                    { count: otherSessions },
                  )}
            </p>
          )}
          {changes && changes.files > 0 && (
            <p className="dirty-tree-count">
              {changes.files === 1
                ? t("1 file changed")
                : formatText("{count} files changed", { count: changes.files })}
              {(changes.additions > 0 || changes.deletions > 0) && (
                <span className="dirty-tree-stat">
                  <span className="added">+{changes.additions}</span>
                  <span className="removed">−{changes.deletions}</span>
                </span>
              )}
            </p>
          )}
          {failed && (
            <p className="dirty-tree-error" role="alert">
              {t("Couldn’t update the working tree.")}
            </p>
          )}
        </div>
      )}
      <div className="button-row dirty-tree-actions">
        <button
          className="secondary"
          disabled={busy !== null}
          onClick={confirmDiscard ? () => setConfirmDiscard(false) : onClose}
        >
          {confirmDiscard ? "Back" : "Cancel"}
        </button>
        {confirmDiscard ? (
          <button
            className="primary danger-button"
            disabled={busy !== null}
            aria-busy={busy === "discard" || undefined}
            onClick={() => void run("discard")}
          >
            Discard
          </button>
        ) : (
          <span className="dirty-tree-split">
            <button
              className="secondary"
              disabled={busy !== null}
              aria-busy={busy !== null || undefined}
              onClick={() =>
                action === "discard"
                  ? setConfirmDiscard(true)
                  : void run(action)
              }
            >
              {labels[action]}
            </button>
            <button
              ref={more}
              className="secondary dirty-tree-more"
              aria-label={t("More options")}
              aria-haspopup="menu"
              aria-expanded={Boolean(menu)}
              disabled={busy !== null}
              onClick={() => {
                if (menu) return setMenu(undefined);
                const box = more.current!.getBoundingClientRect();
                setMenu({
                  right: window.innerWidth - box.right,
                  bottom: window.innerHeight - box.top + 4,
                });
              }}
            >
              <ChevronDown size={13} strokeWidth={1.75} />
            </button>
          </span>
        )}
      </div>
      {menu && (
        <Menu
          label="More options"
          entries={(["stash", "commit", "discard"] as const).map((value) => ({
            label: labels[value],
            checked: value === action,
            onSelect: () => setAction(value),
          }))}
          position={menu}
          width={200}
          anchors={[more]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </Modal>,
    document.body,
  );
}
