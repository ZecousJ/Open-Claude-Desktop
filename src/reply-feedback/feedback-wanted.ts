import type { ReportingStatus } from "../../shared/diagnostics-api";

/**
 * The dialog opens after a thumbs up or down only when the service
 * collects reply feedback and the person agreed in Settings → Privacy;
 * otherwise the rating stays on this computer (package C7). Kept apart
 * from the dialog, which loads only when it opens.
 */
export function feedbackDialogWanted(status: ReportingStatus | null) {
  return !!status?.feedback && status.consented;
}
