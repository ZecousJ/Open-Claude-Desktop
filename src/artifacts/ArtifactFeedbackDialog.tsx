import { useEffect, useState } from "react";
import type { Artifact } from "../ui/ArtifactTypes";
import type { Turn } from "../../shared/types";
import { ReplyFeedbackDialog } from "../reply-feedback/ReplyFeedbackDialog";
import { feedbackDialogWanted } from "../reply-feedback/feedback-wanted";
import { artifactsIn } from "../ui/ArtifactTypes";
import "../reply-feedback/reply-feedback.css";

export function artifactFeedbackTurn(artifact: Artifact, turns: Turn[]) {
  return [...turns]
    .reverse()
    .find(
      (turn) =>
        turn.status === "completed" &&
        turn.items.some(
          (item) =>
            item.generatedFiles?.some((file) =>
              artifact.sourceDigest
                ? file.digest === artifact.sourceDigest
                : file.path === artifact.sourcePath,
            ) ||
            (item.type === "agentMessage" &&
              (artifact.id.startsWith(`${item.id}-`) ||
                Boolean(
                  artifact.libraryId &&
                  artifact.content &&
                  artifactsIn(item.text ?? "", item.id).some(
                    (source) => source.content === artifact.content,
                  ),
                ))),
        ),
    );
}

/** Send feedback uses the existing reply flow. */
export function ArtifactFeedbackDialog({
  artifact,
  onDone,
  onClose,
  onError,
}: {
  artifact: Artifact;
  onDone: (message: string) => void;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const [prompt, setPrompt] = useState<{
    turnId: string;
    allowConversationExcerpt: boolean;
  }>();
  useEffect(() => {
    let live = true;
    const prepare = async () => {
      const conversationId = artifact.conversationId;
      if (!conversationId) throw new Error("Open a session to send feedback.");
      const [conversation, status] = await Promise.all([
        window.desktop.conversationTurns(conversationId),
        window.desktop.reportingStatus(),
      ]);
      const turn = artifactFeedbackTurn(artifact, conversation.turns);
      if (!turn) throw new Error("Feedback isn’t available for this session.");
      await window.desktop.setReplyFeedback(conversationId, turn.id, "down");
      if (!feedbackDialogWanted(status)) {
        if (live) onDone("Thanks for your feedback");
        return;
      }
      if (live)
        setPrompt({
          turnId: turn.id,
          allowConversationExcerpt: status!.allowConversationExcerpt,
        });
    };
    void prepare().catch((error) => {
      if (live) {
        onError(error);
        onClose();
      }
    });
    return () => {
      live = false;
    };
  }, [artifact]);
  if (!prompt || !artifact.conversationId) return null;
  return (
    <ReplyFeedbackDialog
      {...prompt}
      conversationId={artifact.conversationId}
      rating="down"
      submit={(report) => window.desktop.submitReplyFeedback(report)}
      onDone={onDone}
      onClose={onClose}
    />
  );
}
