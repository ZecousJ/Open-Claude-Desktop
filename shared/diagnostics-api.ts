/**
 * Reply ratings and (package C7) the diagnostics and feedback the service
 * collects once its administrator turned collection on and the user agreed
 * in Settings → Privacy → Help improve Claudex. Nothing leaves the computer
 * otherwise. Published fields keep their types; new ones are optional.
 */
import { bridgeMethods } from "./bridge-methods";

export type ReplyRating = "up" | "down";

/** What the service collects and whether the user agreed to send it. */
export interface ReportingStatus {
  /** The administrator collects diagnostics (turn errors, refusals). */
  diagnostics: boolean;
  /** The administrator collects reply feedback. */
  feedback: boolean;
  /** Feedback may include the conversation when the user ticks it. */
  allowConversationExcerpt: boolean;
  /** The user switched Help improve Claudex on. */
  consented: boolean;
  /** This runner implements a separate Code-session report queue. */
  codeSessionFeedback?: boolean;
}

/** A Code issue does not rate or overwrite an individual reply. */
export interface CodeFeedbackReport {
  conversationId: string;
  comment: string;
  includeConversation?: boolean;
  /** Stable for retries of this same description; the collector deduplicates IDs. */
  reportId?: string;
}

/** The feedback dialog's answer for a rated reply. */
export interface ReplyFeedbackReport {
  conversationId: string;
  turnId: string;
  rating: ReplyRating;
  categories?: string[];
  comment?: string;
  reportUrl?: string;
  /** Only honoured when the service allows conversation excerpts. */
  includeConversation?: boolean;
}

export interface DiagnosticsAPI {
  /** Stores a reply's rating on this computer; null clears it. */
  setReplyFeedback(
    conversationId: string,
    turnId: string,
    rating: ReplyRating | null,
  ): Promise<Record<string, ReplyRating>>;
  /** null while the service has not said (local accounts, older services): report nothing. */
  reportingStatus(): Promise<ReportingStatus | null>;
  /**
   * Sends a rated reply's feedback when the service collects feedback and
   * the user agreed; otherwise nothing is sent and `sent` is false.
   */
  submitReplyFeedback(
    report: ReplyFeedbackReport,
  ): Promise<ReplyFeedbackOutcome>;
  submitCodeFeedback(report: CodeFeedbackReport): Promise<ReplyFeedbackOutcome>;
}

/** What happened to a feedback dialog's answer. */
export interface ReplyFeedbackOutcome {
  /** The service accepted it. */
  sent: boolean;
  /** The service could not be reached; it is sent later from this computer. */
  queued?: boolean;
  /** The service kept the feedback but not the conversation. */
  excerptDropped?: boolean;
}

export const diagnosticsMethods = bridgeMethods<DiagnosticsAPI>({
  setReplyFeedback: true,
  reportingStatus: true,
  submitReplyFeedback: true,
  submitCodeFeedback: true,
});
