import { ChevronRight } from "../ui/glyphs";
import type { Approval } from "../../shared/types";
import { approvalKind } from "../approval/approval-model";
import type { Question } from "../approval/QuestionsBody";

/**
 * While the agent waits on its questions: "Asking <header> ⌄" in the
 * transcript's muted tool style with the question under it, one per question,
 * above the question card in the composer.
 */
export function AskingRows({
  conversationId,
  approvals,
}: {
  conversationId: string;
  approvals: Approval[];
}) {
  const questions = approvals
    .filter(
      (approval) =>
        approval.conversationId === conversationId &&
        approvalKind(approval) === "questions",
    )
    .flatMap(
      (approval) =>
        ((approval.params as { questions?: Question[] })?.questions ??
          []) as Question[],
    );
  if (!questions.length) return null;
  return (
    <>
      {questions.map((question) => (
        <details key={question.id} className="code-command asking-row" open>
          <summary>
            <span className="code-command-label" data-running>
              Asking {question.header || "a question"}
            </span>
            <ChevronRight size={16} strokeWidth={1.75} />
          </summary>
          <p>{question.question}</p>
        </details>
      ))}
    </>
  );
}

/** A conversation waits on the agent's questions (the sidebar's "Awaiting input"). */
export function awaitsInput(approvals: Approval[], conversationId: string) {
  return approvals.some(
    (approval) =>
      approval.conversationId === conversationId &&
      approvalKind(approval) === "questions",
  );
}
