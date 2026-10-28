import { randomUUID } from "node:crypto";
import { feedbackReportComment } from "../../shared/feedback-report";
import {
  diagnosticsBody,
  feedbackBody,
  parseDiagnosticsAccepted,
  parseFeedbackAccepted,
  type ReplyFeedbackReport as WireFeedback,
} from "../../shared/claudex-contract";
import type {
  ReplyFeedbackReport,
  ReplyRating,
} from "../../shared/diagnostics-api";
import type { Conversation } from "../../shared/types";
import { Sub2ApiError } from "../sub2api/http";
import {
  redactSecrets,
  feedbackCategories,
  conversationExcerpt,
  maxFeedback,
  batchSize,
  ratingGraceMs,
  minBackoffMs,
  maxBackoffMs,
} from "./diagnostics-support";
import type { DiagnosticsReporter } from "./diagnostics";
import type { PendingFeedback, FeedbackResult, Outcome } from "./diagnostics";

/**
 * A reply was rated (thumbs): the rating is sent after a short wait, so a
 * feedback dialog answer for the same reply replaces it; null withdraws a
 * rating that was not sent yet.
 */
export function rated(
  this: DiagnosticsReporter,
  conversation: Conversation | undefined,
  turnId: string,
  rating: ReplyRating | null,
) {
  if (!conversation) return;
  const others = this.feedback.filter(
    (item) => item.conversationId !== conversation.id || item.turnId !== turnId,
  );
  if (rating === null) {
    if (others.length !== this.feedback.length) {
      this.feedback = others;
      this.save();
    }
    return;
  }
  if (!this.accepts("feedback")) return;
  this.feedback = [
    ...others,
    {
      conversationId: conversation.id,
      turnId,
      dueAt: this.now() + ratingGraceMs,
      report: this.feedbackReport(conversation, rating, [], "", null),
    },
  ].slice(-maxFeedback);
  this.save();
}

export function feedbackReport(
  this: DiagnosticsReporter,
  conversation: Conversation,
  rating: ReplyRating,
  categories: string[],
  comment: string,
  excerpt: string | null,
): WireFeedback {
  return {
    id: randomUUID(),
    rating,
    categories: feedbackCategories(categories),
    comment: redactSecrets(comment).slice(0, 4000),
    ...(conversation.model ? { model: conversation.model } : {}),
    conversationExcerpt: excerpt,
    appVersion: this.options.client.appVersion,
    platform: this.options.client.platform,
  };
}

/**
 * The feedback dialog's answer: replaces a rating still waiting and is sent
 * now. The conversation goes along only when the service allows excerpts
 * and the person ticked it; never for an incognito chat.
 */
export async function submitFeedback(
  this: DiagnosticsReporter,
  conversation: Conversation,
  input: ReplyFeedbackReport,
): Promise<FeedbackResult> {
  return this.submitFeedbackReport(
    conversation,
    input,
    input.turnId,
    input.turnId,
  );
}

/** Session issues use the existing consented collector without touching a reply's rating. */
export async function submitCodeFeedback(
  this: DiagnosticsReporter,
  conversation: Conversation,
  input: import("../../shared/diagnostics-api").CodeFeedbackReport,
): Promise<FeedbackResult> {
  const lastTurn = conversation.turns.at(-1)?.id;
  const reportId = input.reportId ?? randomUUID();
  return this.submitFeedbackReport(
    conversation,
    {
      ...input,
      turnId: lastTurn ?? "",
      rating: "down",
      categories: ["code_session_issue"],
    },
    `code-session:${reportId}`,
    lastTurn,
    reportId,
  );
}

export async function submitFeedbackReport(
  this: DiagnosticsReporter,
  conversation: Conversation,
  input: ReplyFeedbackReport,
  queueKey: string,
  excerptTurnId: string | undefined,
  reportId?: string,
): Promise<FeedbackResult> {
  if (!this.options.consented()) return { sent: false };
  const flags = await this.freshFlags();
  if (!flags?.feedback || !this.accepts("feedback")) return { sent: false };
  const excerpt =
    input.includeConversation &&
    flags.allowConversationExcerpt &&
    !conversation.incognito &&
    excerptTurnId
      ? conversationExcerpt(conversation, excerptTurnId)
      : null;
  const pending: PendingFeedback = {
    conversationId: conversation.id,
    turnId: queueKey,
    dueAt: this.now(),
    report: this.feedbackReport(
      conversation,
      input.rating,
      input.categories ?? [],
      feedbackReportComment(input),
      excerpt,
    ),
  };
  if (reportId) pending.report.id = reportId;
  this.feedback = [
    ...this.feedback.filter(
      (item) =>
        item.conversationId !== conversation.id || item.turnId !== queueKey,
    ),
    pending,
  ].slice(-maxFeedback);
  this.save();
  const { outcome, excerptDropped } = await this.sendFeedback(pending);
  if (outcome === "sent")
    return { sent: true, ...(excerptDropped ? { excerptDropped } : {}) };
  return this.feedback.includes(pending)
    ? { sent: false, queued: true }
    : { sent: false };
}

/** Sends what is due: diagnostics in batches of 50, feedback one by one. */
export function flush(this: DiagnosticsReporter): Promise<void> {
  this.flushing ??= this.flushNow().finally(() => {
    this.flushing = undefined;
  });
  return this.flushing;
}

export async function flushNow(this: DiagnosticsReporter) {
  if (this.stopped) return;
  if (!this.options.consented()) {
    this.clear();
    return;
  }
  if (!this.diagnostics.length && !this.feedback.length) return;
  if (this.now() < this.retryAt) return;
  const flags = await this.freshFlags();
  if (!flags) return;
  while (flags.diagnostics && this.diagnostics.length && !this.stopped) {
    if (!this.options.consented()) return this.clear();
    const batch = this.diagnostics.slice(0, batchSize);
    let outcome: Outcome;
    try {
      parseDiagnosticsAccepted(
        await this.options.post("diagnostics", diagnosticsBody(batch)),
      );
      outcome = "sent";
    } catch (error) {
      outcome = this.failed(error, "diagnostics");
    }
    if (outcome === "retry") return;
    // Sent, or refused for good: either way the batch leaves the queue.
    const ids = new Set(batch.map((item) => item.id));
    this.diagnostics = this.diagnostics.filter((item) => !ids.has(item.id));
    this.save();
    if (outcome === "disabled") break;
  }
  for (const item of [...this.feedback]) {
    if (this.stopped || !this.flags()?.feedback) break;
    if (item.dueAt > this.now() || !this.feedback.includes(item)) continue;
    if ((await this.sendFeedback(item)).outcome === "retry") return;
  }
}

export async function sendFeedback(
  this: DiagnosticsReporter,
  item: PendingFeedback,
): Promise<{ outcome: Outcome; excerptDropped?: boolean }> {
  if (!this.options.consented()) {
    this.clear();
    return { outcome: "dropped" };
  }
  if (this.now() < this.retryAt) return { outcome: "retry" };
  let outcome: Outcome;
  let excerptDropped = false;
  try {
    const accepted = parseFeedbackAccepted(
      await this.options.post("feedback", feedbackBody(item.report)),
    );
    excerptDropped = accepted.excerptDropped;
    outcome = "sent";
  } catch (error) {
    outcome = this.failed(error, "feedback");
  }
  if (outcome !== "retry") {
    this.feedback = this.feedback.filter((other) => other !== item);
    this.save();
  }
  return { outcome, excerptDropped };
}

/** What an upload error means for the queue. */
export function failed(
  this: DiagnosticsReporter,
  error: unknown,
  sort: "diagnostics" | "feedback",
): Outcome {
  const status = error instanceof Sub2ApiError ? error.status : 0;
  if (status === 404) {
    // The service stopped collecting (or never did): nothing of this sort is kept.
    if (sort === "diagnostics") this.diagnostics = [];
    else this.feedback = [];
    this.save();
    this.statusAt = 0;
    return "disabled";
  }
  if (status === 400 || status === 413 || status === 422) return "dropped";
  this.failures++;
  const wait =
    status === 429
      ? Math.max(
          minBackoffMs,
          ((error as Sub2ApiError).retryAfter ?? 3600) * 1000,
        )
      : Math.min(maxBackoffMs, minBackoffMs * 2 ** (this.failures - 1));
  this.retryAt = this.now() + wait;
  return "retry";
}
