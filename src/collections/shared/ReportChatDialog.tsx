import { api } from "../../desktop-api";
import { reportFormCategories } from "../../../shared/sharing";
import type { SharedChatReport } from "../../../shared/sharing-api";
import {
  ReportDialog,
  type ReportAnswer,
} from "../../artifacts/ReportArtifactDialog";

/** The longest notes the service keeps with a report. */
const notesLimit = 1000;

/** The answer as the service takes it; null for a reason the form does not take. */
export function sharedChatReport(
  answer: ReportAnswer,
): SharedChatReport | null {
  if (!(reportFormCategories as readonly string[]).includes(answer.category))
    return null;
  return {
    category: answer.category,
    ...(answer.notes ? { notes: answer.notes.slice(0, notesLimit) } : {}),
    ...(answer.reporterName ? { reporterName: answer.reporterName } : {}),
    ...(answer.reporterEmail ? { reporterEmail: answer.reporterEmail } : {}),
    optOutOfTraining: answer.optOutOfTraining,
  };
}

/**
 * Report chat for a chat shared with the account: the report form with "Opt out
 * of training on this report", sent to the administrator's report queue with
 * the choice. The live page then shows its confirmation screen.
 */
export function ReportChatDialog({
  token,
  onClose,
}: {
  token: string;
  onSent?: (message: string) => void;
  onClose: () => void;
}) {
  return (
    <ReportDialog
      title="Report chat"
      success={{
        title: "Chat reported",
        message:
          "Thank you for helping keep Claudex safe and reliable. We’ll review your report as soon as possible.",
        action: "Return to chat",
      }}
      optOut
      notesLimit={notesLimit}
      onClose={onClose}
      submit={async (answer) => {
        const report = sharedChatReport(answer);
        if (!report) throw new Error("Couldn’t send the report. Try again.");
        await api.reportSharedChat(token, report);
      }}
    />
  );
}
