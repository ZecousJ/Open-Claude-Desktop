import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Controls";
import { t } from "../i18n";
import { feedbackOutcomeMessage } from "../reply-feedback/ReplyFeedbackDialog";
import { showToast } from "../ui/toast-store";
import "./code-feedback.css";

/** O14/ce737b2ad:424-603; collector consent and 4000-char limit are Claudex's C7 contract. */
export function CodeFeedbackDialog({
  conversationId,
  allowConversationExcerpt,
  onClose,
}: {
  conversationId: string;
  allowConversationExcerpt: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [includeConversation, setIncludeConversation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const live = useRef(true),
    sending = useRef(false);
  const attempt = useRef<{ fingerprint: string; reportId: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const close = () => {
    if (sending.current) return;
    if (text.trim()) setDiscard(true);
    else onClose();
  };
  const send = async () => {
    if (sending.current || !text.trim()) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const fingerprint = JSON.stringify([
        conversationId,
        text.trim(),
        allowConversationExcerpt && includeConversation,
      ]);
      const reportId =
        attempt.current?.fingerprint === fingerprint
          ? attempt.current.reportId
          : crypto.randomUUID();
      attempt.current = { fingerprint, reportId };
      const outcome = await window.desktop.submitCodeFeedback({
        conversationId,
        comment: text.trim(),
        includeConversation: allowConversationExcerpt && includeConversation,
        reportId,
      });
      if (!live.current) return;
      if (!outcome.sent && !outcome.queued) {
        setError(feedbackOutcomeMessage(outcome));
        return;
      }
      showToast(feedbackOutcomeMessage(outcome));
      onClose();
    } catch {
      if (live.current) setError("Couldn’t send feedback. Try again.");
    } finally {
      sending.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <>
      <Modal
        title={t("Send feedback")}
        dialogRole="alertdialog"
        className="code-feedback-dialog"
        showClose={false}
        disablePointerDismissal
        onClose={close}
      >
        <textarea
          aria-label={t("Feedback description")}
          placeholder={t("Describe the issue")}
          rows={5}
          maxLength={4000}
          value={text}
          disabled={busy}
          onChange={(event) => {
            setText(event.target.value);
            setError("");
          }}
        />
        <p className="code-feedback-description">
          {t(
            "This report will send your description to the service administrator. They may use it to diagnose related issues and improve Claudex.",
          )}
        </p>
        {allowConversationExcerpt && (
          <label className="code-feedback-excerpt">
            <input
              type="checkbox"
              checked={includeConversation}
              disabled={busy}
              onChange={(event) => setIncludeConversation(event.target.checked)}
            />
            {t("Include this conversation")}
          </label>
        )}
        {busy && (
          <span role="status" className="sr-only">
            {t("Sending…")}
          </span>
        )}
        {error && (
          <p role="alert" className="code-feedback-error">
            {t(error)}
          </p>
        )}
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !text.trim()}
            onClick={() => void send()}
          >
            {t("Send")}
          </button>
        </div>
      </Modal>
      {discard && (
        <Modal
          title={t("Discard unsaved changes?")}
          variant="confirm"
          confirmFocus="cancel"
          onClose={() => setDiscard(false)}
        >
          <p className="confirm-body">
            {t("Your changes haven’t been saved and will be lost.")}
          </p>
          <div className="button-row">
            <button className="secondary" onClick={() => setDiscard(false)}>
              {t("Keep editing")}
            </button>
            <button className="primary danger-button" onClick={onClose}>
              {t("Discard")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
