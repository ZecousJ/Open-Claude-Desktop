import { useEffect, useState } from "react";
import { Modal } from "../ui/Controls";
import { t } from "../i18n";
import "./folder-instructions.css";

export const instructionsExample = `Example:
This folder contains marketing campaign briefs written for external agencies
Tone: direct and professional, not chatty
Keep deliverables and timelines in a table format`;

// Memory editor.
export function FolderInstructions({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.desktop
      .readCoworkInstructions(conversationId)
      .then((value) => {
        if (!cancelled) setContent(value);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);
  const save = async () => {
    setSaving(true);
    setError(false);
    try {
      await window.desktop.writeCoworkInstructions(conversationId, content);
      onClose();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Folder instructions"
      showClose={false}
      className="folder-instructions"
      onClose={onClose}
    >
      <p className="folder-instructions-description">
        Use this to give Claudex instructions for working in this folder.
      </p>
      {loading ? (
        <div className="folder-instructions-loading">Loading...</div>
      ) : (
        <textarea
          aria-label={t("Instructions")}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={t(instructionsExample)}
          spellCheck={false}
        />
      )}
      {error && <p role="alert">Failed to save changes. You can try again.</p>}
      <div className="button-row">
        <button className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={loading || saving}
          aria-busy={saving}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}
