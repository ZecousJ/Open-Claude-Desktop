import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Conversation } from "../../shared/types";
import { surface } from "../../shared/host";
import {
  rewindChanges,
  rewindPreview,
  type RewindScope,
} from "../../shared/rewind-files";
import { formatText, t } from "../i18n";
import { Modal } from "../ui/Controls";
import { Spinner } from "../ui/Spinner";
import "./rewind-dialog.css";

/**
 * "Rewind to this message?": the message, then — when Claude edited files from
 * it on, in a session on this computer — Restore: Code and conversation,
 * Conversation only, Code only, with "{count} files · +a −d" and the note that
 * shell commands' changes aren't reverted. Cancel and Rewind ("Rewinding…").
 */
export default function RewindDialog({
  conversation,
  turnId,
  text,
  onClose,
  onConfirm,
}: {
  conversation: Conversation;
  turnId: string;
  text: string;
  onClose: () => void;
  onConfirm: (scope: RewindScope) => Promise<void>;
}) {
  const [scope, setScope] = useState<RewindScope>("both");
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => {
    const local =
      surface !== "web" &&
      conversation.mode === "code" &&
      (!conversation.environment || conversation.environment.kind === "local");
    const index = conversation.turns.findIndex((turn) => turn.id === turnId);
    if (!local || index < 0) return undefined;
    const changes = rewindChanges(conversation.turns.slice(index));
    return changes.length ? rewindPreview(changes) : undefined;
  }, [conversation, turnId]);
  const confirm = () => {
    setBusy(true);
    void onConfirm(preview ? scope : "conversation").finally(() =>
      setBusy(false),
    );
  };
  return createPortal(
    <Modal
      title="Rewind to this message?"
      onClose={() => !busy && onClose()}
      variant="confirm"
      confirmFocus="cancel"
      className="rewind-dialog"
    >
      <div className="rewind-dialog-body">
        <div className="rewind-dialog-message">
          <span className="sr-only">You</span>
          <p>{text.trim().slice(0, 600)}</p>
        </div>
        {preview && (
          <>
            <label className="rewind-dialog-restore">
              <span>Restore</span>
              <select
                value={scope}
                disabled={busy}
                onChange={(event) =>
                  setScope(event.target.value as RewindScope)
                }
              >
                <option value="both">{t("Code and conversation")}</option>
                <option value="conversation">{t("Conversation only")}</option>
                <option value="code">{t("Code only")}</option>
              </select>
            </label>
            <div
              className="rewind-dialog-summary"
              aria-live="polite"
              data-hidden={scope === "conversation" || undefined}
            >
              <span>
                {preview.filesChanged.length === 1
                  ? t("1 file")
                  : formatText("{count} files", {
                      count: preview.filesChanged.length,
                    })}
                {" · "}
                <span className="rewind-dialog-added">
                  +{preview.insertions}
                </span>{" "}
                <span className="rewind-dialog-removed">
                  −{preview.deletions}
                </span>
              </span>
              <span className="rewind-dialog-note">
                Changes made through shell commands aren’t reverted. Commits
                stay in place.
              </span>
            </div>
          </>
        )}
      </div>
      <div className="button-row">
        <button className="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className={`primary ${busy ? "busy" : ""}`}
          aria-busy={busy || undefined}
          onClick={confirm}
        >
          <span className="busy-label">
            {busy ? t("Rewinding…") : t("Rewind")}
          </span>
          {busy && <Spinner size="sm" inheritColor />}
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
