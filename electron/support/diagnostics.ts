/**
 * Diagnostics and reply feedback reports (package C7, owner decision 1).
 *
 * Nothing leaves the computer unless the Claudex service collects it (its
 * administrator turned collection on, bootstrap `features.diagnostics` /
 * `features.feedback`) and the person switched on Settings → Privacy → Help
 * improve Claudex (`helpImproveClaudex`). Reports wait in
 * `profiles/<id>/diagnostics-queue.json` until they are sent; the file is
 * deleted as soon as consent is withdrawn or the service stops collecting.
 *
 * Diagnostics carry codes and short, known texts only: never prompts,
 * replies, upstream error text or file paths. Reply feedback carries the
 * rating, the categories and comment the person gave, and the conversation
 * only when the service allows it and the person ticked "Include this
 * conversation".
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type BootstrapSource,
  type ClaudexBootstrap,
  type DiagnosticKind,
  type DiagnosticReport,
  type ReplyFeedbackReport as WireFeedback,
} from "../../shared/claudex-contract";
import type { ReportingStatus } from "../../shared/diagnostics-api";
import type { Conversation, Turn } from "../../shared/types";
import { type GatewayRefusal } from "../../server/sub2api-errors";
import {
  reportingFlags,
  redactMessage,
  describeTurnError,
  maxDiagnostics,
  maxFeedback,
  statusMaxAgeMs,
  validQueue,
} from "./diagnostics-support";
import * as diagnosticsFeedback from "./diagnostics-feedback";
import { installMethods } from "./install-methods";

/** What the service collects, from its bootstrap. */
export interface ReportingFlags {
  diagnostics: boolean;
  feedback: boolean;
  allowConversationExcerpt: boolean;
}

export interface PendingFeedback {
  conversationId: string;
  turnId: string;
  /** Not sent before this time (a rating waits for the dialog). */
  dueAt: number;
  report: WireFeedback;
}
export interface QueueFile {
  version: 1;
  diagnostics: DiagnosticReport[];
  feedback: PendingFeedback[];
}

/** Who is reporting: this build and this computer, without names or paths. */
export interface ReporterClient {
  appVersion: string;
  codexVersion?: string;
  platform: string;
  arch: string;
  osVersion?: string;
}

export interface ReporterOptions {
  /** `profiles/<id>/diagnostics-queue.json`. */
  file: string;
  bootstrap: BootstrapSource;
  /** Settings → Privacy → Help improve Claudex. */
  consented: () => boolean;
  /** `POST /api/v1/claudex/<route>` with the signed-in session; throws Sub2ApiError. */
  post: (route: "diagnostics" | "feedback", body: unknown) => Promise<unknown>;
  client: ReporterClient;
  /** The service's switches changed (a fallback bootstrap only). */
  onStatusChanged?: () => void;
  now?: () => number;
  /**
   * Turns that failed before this time are not reported (default: when the
   * reporter was made). The reporter is made on first use, which can be just
   * after a turn started, so the caller passes when the app started.
   */
  since?: number;
  /** Turns already reported, kept across reporters for the same account. */
  seenTurns?: Set<string>;
}

export interface FeedbackResult {
  sent: boolean;
  queued?: boolean;
  excerptDropped?: boolean;
}

/**
 * One signed-in account's reports: the queue on disk, the upload and the
 * rules above. Every public method is safe to call without consent; it then
 * does nothing (and removes anything left on disk).
 */
export class DiagnosticsReporter {
  diagnostics: DiagnosticReport[] = [];
  feedback: PendingFeedback[] = [];
  readonly now: () => number;
  private readonly startedAt: number;
  statusAt = 0;
  private lastStatus: string | undefined;
  retryAt = 0;
  failures = 0;
  flushing?: Promise<void>;
  private seenTurns: Set<string>;
  private lastRefusal?: { message: string; at: number };
  private unsubscribe: () => void;
  stopped = false;
  constructor(public options: ReporterOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = options.since ?? this.now();
    this.seenTurns = options.seenTurns ?? new Set();
    if (options.consented()) this.load();
    else this.deleteFile();
    this.lastStatus = JSON.stringify(
      reportingFlags(options.bootstrap.current()) ?? null,
    );
    this.unsubscribe = options.bootstrap.onChange((bootstrap) =>
      this.applyFlags(reportingFlags(bootstrap)),
    );
  }

  stop() {
    this.stopped = true;
    this.unsubscribe();
  }

  /** Queued reports (tests and the Privacy page have no other view of them). */
  get pending() {
    return {
      diagnostics: this.diagnostics.length,
      feedback: this.feedback.length,
    };
  }

  flags() {
    return reportingFlags(this.options.bootstrap.current());
  }

  /** The service's switches, read again when unknown or older than `maxAge`. */
  async freshFlags(maxAge = statusMaxAgeMs) {
    if (!this.flags() || this.now() - this.statusAt > maxAge) {
      this.statusAt = this.now();
      try {
        await this.options.bootstrap.refresh();
      } catch {
        // Kept as it was; asked again at the next attempt.
      }
      this.applyFlags(this.flags());
    }
    return this.flags();
  }

  /** What Settings → Privacy shows; null while the service has not said. */
  async reportingStatus(maxAge?: number): Promise<ReportingStatus | null> {
    const flags = await this.freshFlags(maxAge);
    if (!flags) return null;
    return { ...flags, consented: this.options.consented() };
  }

  private applyFlags(flags: ReportingFlags | undefined) {
    const key = JSON.stringify(flags ?? null);
    if (key !== this.lastStatus) {
      this.lastStatus = key;
      this.options.onStatusChanged?.();
    }
    if (!flags) return;
    let changed = false;
    if (!flags.diagnostics && this.diagnostics.length) {
      this.diagnostics = [];
      changed = true;
    }
    if (!flags.feedback && this.feedback.length) {
      this.feedback = [];
      changed = true;
    }
    if (changed) this.save();
  }

  /** Settings were saved: withdrawn consent removes every queued report. */
  consentChanged() {
    if (!this.options.consented()) this.clear();
  }

  /** Forgets every queued report and deletes the queue file. */
  clear() {
    this.diagnostics = [];
    this.feedback = [];
    this.deleteFile();
  }

  /** Whether a report of this sort may be kept now. */
  accepts(sort: "diagnostics" | "feedback") {
    if (this.stopped || !this.options.consented()) return false;
    const flags = this.flags();
    // Before the first bootstrap the report waits; it is sent only once the
    // service says it collects, and dropped when it says it does not.
    return !flags || flags[sort];
  }

  /** Queues one diagnostic report; false when it may not be kept. */
  record(input: {
    kind: DiagnosticKind;
    code: string;
    message?: string;
    model?: string;
    requestId?: string;
    context?: DiagnosticReport["context"];
  }) {
    if (!this.accepts("diagnostics")) return false;
    const client = this.options.client;
    const report: DiagnosticReport = {
      id: randomUUID(),
      occurredAt: this.now(),
      kind: input.kind,
      code: input.code.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64),
      // The service keeps no upstream text for refusals; neither do we.
      message:
        input.kind === "gateway_refusal"
          ? ""
          : redactMessage(input.message ?? ""),
      ...(input.requestId ? { requestId: input.requestId.slice(0, 128) } : {}),
      ...(input.model ? { model: input.model.slice(0, 200) } : {}),
      appVersion: client.appVersion,
      ...(client.codexVersion ? { codexVersion: client.codexVersion } : {}),
      platform: client.platform,
      arch: client.arch,
      ...(client.osVersion ? { osVersion: client.osVersion } : {}),
      ...(input.context
        ? {
            context: Object.fromEntries(
              Object.entries(input.context)
                .filter(([, value]) => value !== undefined && value !== "")
                .map(([key, value]) => [
                  key,
                  typeof value === "string" ? redactMessage(value) : value,
                ]),
            ),
          }
        : {}),
    };
    this.diagnostics = [...this.diagnostics, report].slice(-maxDiagnostics);
    this.save();
    return true;
  }

  /** A gateway refusal: its code and the service's reason, never its text. */
  recordRefusal(
    refusal: GatewayRefusal,
    surface?: string,
    model?: string,
    requestId = refusal.requestId,
  ) {
    this.lastRefusal = { message: refusal.message, at: this.now() };
    return this.record({
      kind: "gateway_refusal",
      code: refusal.code || `HTTP_${refusal.status}`,
      model,
      ...(requestId ? { requestId } : {}),
      context: {
        ...(surface ? { surface } : {}),
        ...(refusal.reason ? { reason: refusal.reason } : {}),
        ...(refusal.status ? { http_status: refusal.status } : {}),
      },
    });
  }

  /** A conversation changed: turns that failed since this reporter started are reported once. */
  observeConversation(conversation: Conversation) {
    if (!this.accepts("diagnostics")) return;
    for (const turn of conversation.turns)
      if (turn.status === "failed" && turn.createdAt >= this.startedAt)
        this.recordTurnError(conversation, turn);
  }

  private recordTurnError(conversation: Conversation, turn: Turn) {
    const key = `${conversation.id}\u0000${turn.id}`;
    if (this.seenTurns.has(key)) return;
    this.seenTurns.add(key);
    if (this.seenTurns.size > 2000)
      for (const old of [...this.seenTurns].slice(0, 1000))
        this.seenTurns.delete(old);
    const error = turn.error ?? "";
    if (
      this.lastRefusal &&
      this.lastRefusal.message === error &&
      this.now() - this.lastRefusal.at < 5 * 60_000
    )
      return;
    const described = describeTurnError(error);
    if (!described) return;
    this.record({
      kind: "turn_error",
      code: described.code,
      message: described.message,
      model: conversation.model,
      context: { surface: conversation.mode },
    });
  }

  /** A conversation was deleted: its unsent feedback goes with it. */
  forgetConversation(conversationId: string) {
    const kept = this.feedback.filter(
      (item) => item.conversationId !== conversationId,
    );
    if (kept.length === this.feedback.length) return;
    this.feedback = kept;
    this.save();
  }

  private load() {
    try {
      const data: unknown = JSON.parse(
        fs.readFileSync(this.options.file, "utf8"),
      );
      if (!validQueue(data)) throw Error("Invalid diagnostics queue.");
      this.diagnostics = data.diagnostics.slice(-maxDiagnostics);
      this.feedback = data.feedback.slice(-maxFeedback);
    } catch (error) {
      // A damaged queue holds nothing worth keeping.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.deleteFile();
    }
  }

  save() {
    if (this.retryAt && !this.diagnostics.length && !this.feedback.length) {
      this.retryAt = 0;
      this.failures = 0;
    }
    if (!this.diagnostics.length && !this.feedback.length) {
      this.deleteFile();
      return;
    }
    if (!this.options.consented()) {
      this.clear();
      return;
    }
    const data: QueueFile = {
      version: 1,
      diagnostics: this.diagnostics,
      feedback: this.feedback,
    };
    const temporary = `${this.options.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.options.file), {
        recursive: true,
        mode: 0o700,
      });
      fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(temporary, this.options.file);
    } catch (error) {
      console.error(
        "Diagnostics queue could not be saved:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private deleteFile() {
    for (const file of [this.options.file, `${this.options.file}.tmp`])
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Nothing to remove.
      }
  }
}

export interface DiagnosticsReporter {
  rated: OmitThisParameter<typeof diagnosticsFeedback.rated>;
  feedbackReport: OmitThisParameter<typeof diagnosticsFeedback.feedbackReport>;
  submitFeedback: OmitThisParameter<typeof diagnosticsFeedback.submitFeedback>;
  submitCodeFeedback: OmitThisParameter<
    typeof diagnosticsFeedback.submitCodeFeedback
  >;
  submitFeedbackReport: OmitThisParameter<
    typeof diagnosticsFeedback.submitFeedbackReport
  >;
  flush: OmitThisParameter<typeof diagnosticsFeedback.flush>;
  flushNow: OmitThisParameter<typeof diagnosticsFeedback.flushNow>;
  sendFeedback: OmitThisParameter<typeof diagnosticsFeedback.sendFeedback>;
  failed: OmitThisParameter<typeof diagnosticsFeedback.failed>;
}
installMethods(DiagnosticsReporter.prototype, diagnosticsFeedback);
export type Outcome = "sent" | "retry" | "dropped" | "disabled";

/**
 * A BootstrapSource read on demand, for services where no other part of the
 * client keeps the bootstrap current (until package C2's source exists).
 */
export class FetchedBootstrap implements BootstrapSource {
  private value?: ClaudexBootstrap;
  private etag?: string;
  private reading?: Promise<ClaudexBootstrap | undefined>;
  private listeners = new Set<(value: ClaudexBootstrap | undefined) => void>();
  constructor(
    private load: (
      etag: string | undefined,
    ) => Promise<
      | { notModified: true }
      | { notModified: false; data: ClaudexBootstrap; etag?: string }
    >,
  ) {}
  current() {
    return this.value;
  }
  refresh() {
    this.reading ??= this.read().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }
  private async read() {
    const result = await this.load(this.etag);
    if (result.notModified) return this.value;
    this.etag = result.etag;
    this.value = result.data;
    for (const listener of [...this.listeners]) listener(this.value);
    return this.value;
  }
  onChange(listener: (value: ClaudexBootstrap | undefined) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
