import { t, useT } from "../../i18n";
import { type FormEvent } from "react";
import {
  File as FileGlyph,
  FileSpreadsheet,
  Image as ImageGlyph,
} from "../../ui/glyphs";
import { Modal } from "../../ui/Controls";
import { usePresence } from "../../ui/usePresence";
import { type ZoneDropState } from "../../composer/drop-zones";
import "./knowledge-list.css";

/** What a failed Add text content says: the reason, else the live generic line. */
export function textSaveError(error: unknown) {
  const reason = error instanceof Error ? error.message.trim() : "";
  return new Error(reason || t("Error saving text content"));
}

export type TextDraft = { name: string; text: string };

/**
 * Add text content: Title ("Name your content") and Content ("Type or paste in
 * content..."), both required when Add Content is pressed; saved as a Markdown
 * file.
 */
export function AddTextDialog({
  draft,
  onDraft,
  onClose,
  onSave,
}: {
  draft: TextDraft;
  onDraft: (draft: TextDraft) => void;
  onClose: () => void;
  onSave: (file: TextDraft) => void;
}) {
  const { name, text } = draft;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !text.trim()) return;
    onSave({ name: name.trim(), text });
  }
  return (
    <Modal title="Add text content" onClose={onClose} wide>
      <form className="prj-text-form" onSubmit={submit}>
        <label>
          Title
          <input
            autoFocus
            required
            maxLength={100}
            placeholder="Name your content"
            value={name}
            onChange={(event) => onDraft({ name: event.target.value, text })}
          />
        </label>
        <label>
          Content
          <textarea
            required
            rows={12}
            placeholder="Type or paste in content..."
            value={text}
            onChange={(event) => onDraft({ name, text: event.target.value })}
          />
        </label>
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">Add Content</button>
        </div>
      </form>
    </Modal>
  );
}

/** The overlay's exit: everything fades out over 200ms (live). */
const dropExitMs = 200;

/**
 * What a file drag shows over the project's rail: the rail blurs under the page
 * colour at 60%, with a dashed accent rim while the drag is elsewhere in the
 * window and a solid ring with a soft glow once it is over the rail (red when
 * the files can't be added), three tilted icons and "Drop files here to add to
 * project knowledge" (or why it is refused).
 */
export function KnowledgeDropOverlay({
  state,
  message,
}: {
  state: ZoneDropState;
  message?: string;
}) {
  useT();
  const presence = usePresence(state !== "idle", dropExitMs);
  if (!presence.mounted) return null;
  const over = state === "on-target" || state === "rejected";
  return (
    <div
      className="prj-drop"
      data-state={presence.state}
      data-drag-over={over || undefined}
      data-drag-rejected={state === "rejected" || undefined}
      aria-hidden="true"
    >
      <div className="prj-drop-blur" />
      <div className="prj-drop-scrim" />
      <div className="prj-drop-dashed" />
      <div className="prj-drop-ring">
        <div className="prj-drop-glow" />
      </div>
      <div className="prj-drop-content">
        <div className="prj-drop-icons">
          <span className="tilt-left">
            <ImageGlyph size={28} strokeWidth={1.5} />
          </span>
          <span className="raised">
            <FileGlyph size={28} strokeWidth={1.5} />
          </span>
          <span className="tilt-right">
            <FileSpreadsheet size={28} strokeWidth={1.5} />
          </span>
        </div>
        <span className="prj-drop-label">
          {message ?? t("Drop files here to add to project knowledge")}
        </span>
      </div>
    </div>
  );
}

/** The empty Context box's picture: a sheet over a smaller one. */
export function ContextSheets() {
  return (
    <svg
      className="prj-context-sheets"
      width="44"
      height="36"
      viewBox="0 0 44 36"
      fill="none"
      aria-hidden="true"
    >
      <rect x="18" y="2" width="24" height="30" rx="3" />
      <rect x="2" y="8" width="24" height="26" rx="3" className="front" />
      <path d="M7 15h12M7 19h12M7 23h8" />
    </svg>
  );
}
