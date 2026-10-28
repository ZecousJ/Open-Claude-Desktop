import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Controls";
import { isComposingKey } from "../ui/ime";
import { cleanArtifactName } from "./artifact-name";

/**
 * Rename artifact, from the Artifacts page: a dialog with the name selected in
 * a field, Cancel and Save. Save stays disabled until the name, cleaned of
 * control characters and extra blanks, is not empty and differs from the
 * current one. The reference's other rename (the artifact panel's title) edits
 * in place.
 */
export function RenameArtifactDialog({
  name,
  onSave,
  onClose,
}: {
  name: string;
  /** Called with the cleaned name; a thrown error is left to the caller. */
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const clean = cleanArtifactName(draft);
  const changed = clean !== "" && clean !== cleanArtifactName(name);
  // The dialog focuses its first control after this effect.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <Modal title="Rename artifact" onClose={onClose}>
      <form
        className="rename-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!changed) return;
          onSave(clean);
          onClose();
        }}
      >
        <input
          ref={input}
          aria-label="Artifact name"
          value={draft}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
          // The Enter that accepts an IME candidate must not submit the form.
          onKeyDown={(event) => {
            if (event.key === "Enter" && isComposingKey(event))
              event.preventDefault();
          }}
        />
        <div className="rename-actions">
          <button type="button" className="rename-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="rename-save" disabled={!changed}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
