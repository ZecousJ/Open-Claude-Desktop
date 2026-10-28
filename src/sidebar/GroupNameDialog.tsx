import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Controls";
import "./code-section-dialog.css";

/**
 * The name of a custom group, asked in a small dialog. Rename group takes the
 * same dialog with the current name. The dialog keeps the rename dialog's look
 * (collections.css .rename-form), and the primary button stays disabled until
 * there is a name that differs from the start.
 */
export function GroupNameDialog({
  title,
  initial = "",
  confirm,
  note,
  section = false,
  onSubmit,
  onError,
  onClose,
}: {
  title: string;
  initial?: string;
  confirm: string;
  note?: string;
  /** Current Code session list: New section, O14/shared-20:16790–16945. */
  section?: boolean;
  /** Resolves when the group is saved; a rejection is reported and the dialog stays. */
  onSubmit: (name: string) => Promise<void>;
  onError: (error: unknown) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const name = draft.replace(/\s+/g, " ").trim();
  const ready = name !== "" && name !== initial && !busy;
  // The dialog focuses its first control after this effect.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <Modal
      title={title}
      onClose={onClose}
      className={section ? "code-section-dialog" : ""}
      showClose={!section}
    >
      <form
        className="rename-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setBusy(true);
          onSubmit(name).then(onClose, (error) => {
            setBusy(false);
            onError(error);
          });
        }}
      >
        <input
          ref={input}
          aria-label={section ? "Section name" : "Group name"}
          placeholder={section ? "Section name" : "Group name"}
          maxLength={60}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        {note && <p className="group-name-note">{note}</p>}
        <div className="rename-actions">
          <button type="button" className="rename-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="rename-save" disabled={!ready}>
            {confirm}
          </button>
        </div>
      </form>
    </Modal>
  );
}
