import { ReplyFeedbackDialog } from "../reply-feedback/ReplyFeedbackDialog";
import { showToast } from "../ui/toast-store";
import "../reply-feedback/reply-feedback.css";

export function ConversationFeedback({
  conversationId,
  turnId,
  allowConversationExcerpt,
  onClose,
}: {
  conversationId: string;
  turnId: string;
  allowConversationExcerpt: boolean;
  onClose: () => void;
}) {
  return (
    <ReplyFeedbackDialog
      conversationId={conversationId}
      turnId={turnId}
      rating="down"
      allowConversationExcerpt={allowConversationExcerpt}
      submit={(report) => window.desktop.submitReplyFeedback(report)}
      onDone={(message) => {
        showToast(message);
        onClose();
      }}
      onClose={onClose}
    />
  );
}
