import { useContext, useRef, useState } from "react";
import { ChevronDown } from "../ui/glyphs";
import type {
  ReplyFeedbackOutcome,
  ReplyFeedbackReport,
  ReplyRating,
} from "../../shared/diagnostics-api";
import { Modal } from "../ui/Controls";
import { Menu } from "../ui/Menu";
import type { Conversation } from "../../shared/types";
import { feedbackCategoriesFor } from "./categories";
import { feedbackReportComment } from "../../shared/feedback-report";
import { AppContext } from "../app/AppContext";

export { negativeCategories, feedbackCategoriesFor } from "./categories";

export { feedbackDialogWanted } from "./feedback-wanted";

/** What the person is told after Submit. */
export function feedbackOutcomeMessage(outcome: ReplyFeedbackOutcome) {
  if (outcome.sent)
    return outcome.excerptDropped
      ? "Thanks for your feedback. The conversation was not included."
      : "Thanks for your feedback";
  if (outcome.queued)
    return "Thanks for your feedback. It will be sent when Claudex can reach the service.";
  return "Your feedback could not be sent.";
}

/** Submit is offered once there is something to send beyond the rating. */
export function feedbackSubmittable(comment: string, categories: string[]) {
  return comment.trim().length > 0 || categories.length > 0;
}

/**
 * The reply feedback dialog: a 520px card with a 22px title and no close
 * button, the issue type as one menu-backed field (thumbs down only), the
 * details under a muted label, an italic note and Cancel and Submit. The
 * wording of the note is Claudex's own: feedback goes to the administrator. The
 * rating itself was already stored; this adds what the person writes and, when
 * the service allows it and the box is ticked, the conversation.
 */
export function ReplyFeedbackDialog({
  conversationId,
  turnId,
  rating,
  conversation,
  memoryAvailable,
  webSearchAvailable,
  allowConversationExcerpt,
  submit,
  onDone,
  onClose,
}: {
  conversationId: string;
  turnId: string;
  rating: ReplyRating;
  conversation?: Conversation;
  memoryAvailable?: boolean;
  webSearchAvailable?: boolean;
  allowConversationExcerpt: boolean;
  submit: (report: ReplyFeedbackReport) => Promise<ReplyFeedbackOutcome>;
  /** After Submit, with the message for the toast. */
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const app = useContext(AppContext);
  const [comment, setComment] = useState("");
  const [reportUrl, setReportUrl] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [choosing, setChoosing] = useState(false);
  const selectButton = useRef<HTMLButtonElement>(null);
  const [includeConversation, setIncludeConversation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const positive = rating === "up";
  const availableCategories = feedbackCategoriesFor({
    conversation:
      conversation ??
      app?.snapshot.conversations.find((item) => item.id === conversationId),
    turnId,
    memoryAvailable: memoryAvailable ?? app?.policy.memory?.enabled,
    webSearchAvailable: webSearchAvailable ?? app?.policy.webSearch,
  });
  const chosen = availableCategories.find((item) => item.id === categories[0]);
  async function send() {
    if (busy || !feedbackSubmittable(comment, categories)) return;
    setBusy(true);
    setError("");
    try {
      feedbackReportComment({
        conversationId,
        turnId,
        rating,
        categories,
        comment,
        reportUrl,
      });
      const outcome = await submit({
        conversationId,
        turnId,
        rating,
        comment: comment.trim(),
        ...(categories.includes("web_url") ? { reportUrl } : {}),
        ...(positive ? {} : { categories }),
        ...(allowConversationExcerpt && includeConversation
          ? { includeConversation: true }
          : {}),
      });
      if (!outcome.sent && !outcome.queued) {
        setError(feedbackOutcomeMessage(outcome));
        return;
      }
      onDone(feedbackOutcomeMessage(outcome));
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Your feedback could not be sent.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={positive ? "Give positive feedback" : "Give negative feedback"}
      className="reply-feedback-modal"
      onClose={onClose}
    >
      <form
        className="reply-feedback"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {!positive && (
          <div className="reply-feedback-type">
            <span id="reply-feedback-type" className="reply-feedback-label">
              What type of issue do you wish to report? (optional)
            </span>
            <button
              ref={selectButton}
              type="button"
              className="reply-feedback-select"
              role="combobox"
              aria-labelledby="reply-feedback-type"
              aria-haspopup="listbox"
              aria-expanded={choosing}
              data-empty={chosen ? undefined : true}
              onClick={() => setChoosing(!choosing)}
            >
              <span>{chosen?.label ?? "Select…"}</span>
              <ChevronDown size={16} strokeWidth={1.6} aria-hidden="true" />
            </button>
            {choosing && selectButton.current && (
              <Menu
                label="Issue type"
                width={selectButton.current.getBoundingClientRect().width}
                position={{
                  left: selectButton.current.getBoundingClientRect().left,
                  top: selectButton.current.getBoundingClientRect().bottom + 4,
                }}
                anchors={[selectButton]}
                entries={availableCategories.map((category) => ({
                  label: category.label,
                  checked: category.id === categories[0],
                  onSelect: () => setCategories([category.id]),
                }))}
                onClose={() => setChoosing(false)}
              />
            )}
          </div>
        )}
        {categories.includes("web_url") && (
          <label className="reply-feedback-details">
            <span className="reply-feedback-details-label">Report a URL</span>
            <input
              type="url"
              required
              maxLength={2000}
              value={reportUrl}
              onChange={(event) => setReportUrl(event.target.value)}
            />
          </label>
        )}
        <label className="reply-feedback-details">
          <span className="reply-feedback-details-label">
            Please provide details: (optional)
          </span>
          <textarea
            rows={3}
            maxLength={4000}
            value={comment}
            autoFocus
            placeholder={
              positive
                ? "What was satisfying about this response?"
                : "What was unsatisfying about this response?"
            }
            onChange={(event) => setComment(event.target.value)}
          />
        </label>
        {allowConversationExcerpt && (
          <label className="reply-feedback-check reply-feedback-include">
            <input
              type="checkbox"
              className="cx-check-input"
              checked={includeConversation}
              onChange={(event) => setIncludeConversation(event.target.checked)}
            />
            <span>Include this conversation</span>
          </label>
        )}
        <p className="reply-feedback-note">
          {allowConversationExcerpt
            ? "Your feedback goes to your Claudex administrator. The conversation up to this reply is included only when you tick the box."
            : "Your feedback goes to your Claudex administrator, without the conversation."}
        </p>
        {error && (
          <p className="reply-feedback-error" role="alert">
            {error}
          </p>
        )}
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !feedbackSubmittable(comment, categories)}
          >
            Submit
          </button>
        </div>
      </form>
    </Modal>
  );
}
