import { Modal } from "../ui/Controls";
import { useDiscardDraftQuestion } from "./discard-draft";

/**
 * "Discard draft?" when a split pane with an unsent draft is closed: Keep
 * editing first and focused, then Start session, then the red Discard. Laid out
 * as the closest captured analogue, Create a skill's "Discard this draft?".
 */
export function DiscardDraftDialog() {
  const question = useDiscardDraftQuestion();
  if (!question) return null;
  const { preview, answer } = question;
  return (
    <Modal
      title="Discard draft?"
      onClose={() => answer("cancel")}
      variant="confirm"
      confirmFocus="cancel"
    >
      <p className="confirm-body">
        {preview
          ? `“${preview}” hasn’t been sent. Start a session from it, or discard it?`
          : "This draft hasn’t been sent. Start a session from it, or discard it?"}
      </p>
      <div className="button-row">
        <button className="secondary" onClick={() => answer("cancel")}>
          Keep editing
        </button>
        <button className="secondary" onClick={() => answer("start")}>
          Start session
        </button>
        <button
          className="primary danger-button"
          onClick={() => answer("discard")}
        >
          Discard
        </button>
      </div>
    </Modal>
  );
}
