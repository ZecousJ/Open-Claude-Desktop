import { useLayoutEffect, useRef } from "react";
import { t } from "../i18n";
import { Info } from "../ui/glyphs";
import { WithTooltip } from "../ui/Tooltip";

/**
 * A sent prompt's editor: the text field that replaces the bubble's text and
 * the row under it with the note about saving, Cancel and Save. Chat and Cowork
 * share it. It renders inside `.user-message`, which the caller marks
 * `is-editing`.
 */
export function PromptEdit({
  original,
  draft,
  onDraft,
  busy,
  note,
  onSave,
  onCancel,
}: {
  /** The prompt as sent; Save stays off until the text differs from it. */
  original: string;
  draft: string;
  onDraft: (text: string) => void;
  /** A reply is still being written: the text can change but not be saved. */
  busy: boolean;
  /** What saving does, in the original's words for this mode. */
  note: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const saveable = !busy && Boolean(draft.trim()) && draft !== original;
  useLayoutEffect(() => {
    if (!area.current) return;
    area.current.style.height = "0px";
    area.current.style.height = `${area.current.scrollHeight}px`;
  }, [draft]);
  // user-edit-001: the caret opens at the end of the existing text.
  useLayoutEffect(() => {
    if (!area.current) return;
    const end = area.current.value.length;
    area.current.setSelectionRange(end, end);
  }, []);
  return (
    <>
      <textarea
        ref={area}
        aria-label={t("Edit message")}
        autoFocus
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          // Enter and Cmd/Ctrl+Enter save when Save is enabled.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (saveable) onSave();
          }
        }}
      />
      <div className="user-edit-actions">
        <WithTooltip label={note} placement="above">
          {(tooltip) => (
            <span
              {...tooltip}
              className="user-edit-note"
              tabIndex={0}
              role="img"
              aria-label={t("About saving")}
            >
              <Info size={13} />
            </span>
          )}
        </WithTooltip>
        <button onClick={onCancel}>{t("Cancel")}</button>
        <button className="save-message" disabled={!saveable} onClick={onSave}>
          {t("Save")}
        </button>
      </div>
    </>
  );
}
