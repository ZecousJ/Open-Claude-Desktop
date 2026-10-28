import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "../ui/glyphs";
import { useDialogOverlay } from "../ui/dialog-stack";
import {
  artifactReportContentChars,
  reportFormCategories,
} from "../../shared/sharing";
import type {
  ArtifactReport,
  ArtifactReportsState,
} from "../../shared/sharing-api";

/** The reasons offered, in the original's order. */
export const reportReasons = [
  "Copyright infringement",
  "Trademark infringement",
  "Child safety/sexual abuse",
  "Fraud",
  "Sexually Explicit content",
  "Non-consensual intimate imagery",
  "Violence and/or hate speech",
  "Illegal goods",
  "Court order",
  "Private/confidential information",
  "Defamation",
  "Other illegal or unlawful content",
  "Violation of terms or usage policy",
] as const;

export type ReportReason = (typeof reportReasons)[number];

/**
 * Each reason's category as the live report form sends it and the Claudex
 * service stores it.
 */
export const reportCategoryIds: Record<ReportReason, string> = {
  "Copyright infringement": "copyright_infringement",
  "Trademark infringement": "trademark_infringement",
  "Child safety/sexual abuse": "child_safety",
  Fraud: "fraud",
  "Sexually Explicit content": "sexually_explicit_content",
  "Non-consensual intimate imagery": "non_consensual_intimate_imagery",
  "Violence and/or hate speech": "violence_and_hate",
  "Illegal goods": "illegal_goods",
  "Court order": "court_order",
  "Private/confidential information": "private_or_confidential_information",
  Defamation: "defamation",
  "Other illegal or unlawful content": "other_illegal",
  "Violation of terms or usage policy": "violation_of_terms",
};

/**
 * The reasons the original does not take in this form: it points them to
 * its content-reporting form. Claudex has no such form, so the sentence is
 * shown and nothing can be sent for them.
 */
export const formReasons: readonly string[] = [
  "Copyright infringement",
  "Trademark infringement",
  "Private/confidential information",
  "Court order",
];

/** The longest name and email, and notes, the original's report takes. */
const limits = { name: 255, email: 255, notes: 1024 };

/**
 * Why Report can't be sent: reports go to the administrator of a Claudex
 * service, and this account (a local one) or its service has nowhere to
 * take them. The dialog never pretends a report went anywhere.
 */
export const reportUnavailable =
  "Only an account on a Claudex service can send reports; they go to its administrator.";

/** Why Report can't be sent: the administrator turned reports off. */
export const reportsTurnedOff = "Your administrator has turned off reports.";

/**
 * The note under "Opt out of training on this report". The live wording
 * says Anthropic's Trust & Safety team trains on reports; in Claudex the
 * reports go to the administrator, so the note says that instead.
 */
export const optOutNote =
  "Reports help your Claudex administrator keep this service safe and enforce its usage policy. Unless you opt out, your administrator may use reports to train models for moderation. Opt out of this use by changing the toggle above.";

/** What the report form sends. */
export interface ReportAnswer {
  /** The live form's category (`reportCategoryIds`). */
  category: string;
  notes: string;
  reporterName: string;
  reporterEmail: string;
  /** Always false when the dialog does not offer the switch. */
  optOutOfTraining: boolean;
}

/**
 * The original's report form in the publish dialog's frame (512 wide, 20
 * inset): "Why are you reporting this?" with a reason list, then Your name,
 * Your email and Additional information (all optional), or for copyright,
 * trademark, private information and court orders a sentence that asks for a
 * different form instead; Close and Report.
 *
 * With `optOut` the form also has the live "Opt out of training on this report"
 * switch, off until the reporter turns it on. Without `submit` nothing receives
 * reports: Report stays disabled with the reason. With it, Close and Report
 * show once a reason the form takes is chosen, as in the live form.
 */
export function ReportDialog({
  title,
  onClose,
  submit,
  optOut = false,
  notesLimit = limits.notes,
  defaultReason = "",
  checking = false,
  unavailable = reportUnavailable,
  success,
}: {
  title: string;
  onClose: () => void;
  /** Sends the report; resolves once the service took it. */
  submit?: (answer: ReportAnswer) => Promise<void>;
  optOut?: boolean;
  notesLimit?: number;
  /** The reason chosen when the dialog opens (none by default). */
  defaultReason?: ReportReason | "";
  /**
   * Without `submit`: whether reports can be sent is still being asked, so
   * Report waits, disabled, without a reason.
   */
  checking?: boolean;
  /** Without `submit`: why Report is disabled. */
  unavailable?: string;
  success?: { title: string; message: string; action: string };
}) {
  const blocked = !submit && !checking;
  const [reason, setReason] = useState<string>(defaultReason),
    [reporter, setReporter] = useState(""),
    [email, setEmail] = useState(""),
    [notes, setNotes] = useState(""),
    [optedOut, setOptedOut] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [submitted, setSubmitted] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [previous] = useState(() =>
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("select")?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
      if (event.key === "Tab") {
        const items = [
          ...(root.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),select,input,textarea",
          ) ?? []),
        ];
        if (!items.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);
  const overlay = useDialogOverlay();
  const takes = !!reason && !formReasons.includes(reason);
  async function send() {
    if (!submit || !takes || busy) return;
    setBusy(true);
    setError("");
    try {
      await submit({
        category: reportCategoryIds[reason as ReportReason],
        notes: notes.trim(),
        reporterName: reporter.trim(),
        reporterEmail: email.trim(),
        optOutOfTraining: optOut && optedOut,
      });
      if (success) setSubmitted(true);
      else onClose();
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : "Couldn’t send the report. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  const dialog = (
    <div
      {...overlay}
      className="overlay publish-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={root}
        className="publish-dialog report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-dialog-title"
        aria-describedby={blocked ? "report-dialog-unavailable" : undefined}
      >
        <header>
          <h2 id="report-dialog-title">{submitted ? success!.title : title}</h2>
          <button
            className="publish-dialog-close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        {submitted ? (
          <>
            <p className="report-dialog-form-note">{success!.message}</p>
            <div className="publish-dialog-actions">
              <span />
              <button className="publish-dialog-publish" onClick={onClose}>
                {success!.action}
              </button>
            </div>
          </>
        ) : (
          <label className="report-dialog-field">
            Why are you reporting this?
            <select
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            >
              <option value="" disabled>
                Select report reason
              </option>
              {reportReasons.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        )}
        {!submitted && (
          <>
            {formReasons.includes(reason) ? (
              <p className="report-dialog-form-note" role="note">
                Please use this form to report copyright infringement.
              </p>
            ) : (
              reason && (
                <>
                  <label className="report-dialog-field">
                    Your name
                    <input
                      value={reporter}
                      placeholder="Optional"
                      maxLength={limits.name}
                      onChange={(event) => setReporter(event.target.value)}
                    />
                  </label>
                  <label className="report-dialog-field">
                    Your email
                    <small>
                      If provided, we may contact you for additional information
                      or updates on this report
                    </small>
                    <input
                      type="email"
                      value={email}
                      placeholder="Optional"
                      maxLength={limits.email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                  <label className="report-dialog-field">
                    Additional information
                    <small>
                      Please provide any additional information to help us
                      understand your request.
                    </small>
                    <small>
                      If you are reporting the content as illegal/unlawful,
                      please describe in detail why you believe the identified
                      content is illegal/unlawful, citing specific provisions of
                      law wherever possible.
                    </small>
                    <small>
                      If you are reporting the content as violating our policies
                      (including our terms or Usage Policy), please describe in
                      detail why you believe the identified content is in
                      violation of our policies, with specific citations to our
                      policies wherever possible.
                    </small>
                    <textarea
                      rows={3}
                      value={notes}
                      placeholder="Optional"
                      maxLength={notesLimit}
                      onChange={(event) => setNotes(event.target.value)}
                    />
                  </label>
                  {optOut && (
                    <div className="report-dialog-field">
                      <div className="report-dialog-switch">
                        <span id="report-dialog-opt-out">
                          Opt out of training on this report
                        </span>
                        <button
                          type="button"
                          role="switch"
                          className="settings-toggle"
                          aria-labelledby="report-dialog-opt-out"
                          aria-describedby="report-dialog-opt-out-note"
                          aria-checked={optedOut}
                          onClick={() => setOptedOut(!optedOut)}
                        >
                          <span />
                        </button>
                      </div>
                      <small id="report-dialog-opt-out-note">
                        {optOutNote}
                      </small>
                    </div>
                  )}
                </>
              )
            )}
            {blocked && (
              <p
                id="report-dialog-unavailable"
                className="publish-dialog-note"
                role="note"
              >
                {unavailable}
              </p>
            )}
            {error && (
              <p className="publish-dialog-error" role="alert">
                {error}
              </p>
            )}
            {!submitted && (!submit || takes) && (
              <div className="publish-dialog-actions">
                <span />
                <button onClick={onClose}>Close</button>
                {submit ? (
                  <button
                    className="publish-dialog-publish"
                    disabled={busy}
                    onClick={() => void send()}
                  >
                    Report
                  </button>
                ) : (
                  <button
                    className="publish-dialog-publish"
                    disabled
                    title={blocked ? unavailable : undefined}
                  >
                    Report
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
  // Server rendering (the tests) has no body to portal into.
  return typeof document === "undefined"
    ? dialog
    : createPortal(dialog, document.body);
}

/** The artifact a report is about. */
export interface ReportedArtifact {
  identity: string;
  title: string;
  language: string;
  content: string;
  /** A binary file: no text to copy, only its size. */
  blob?: boolean;
  bytes?: number;
}

/**
 * What Report artifact sends for an answer: the form's fields, empty ones
 * left out, and a copy of the artifact cut to `artifactReportContentChars`
 * with the whole size when cut (a binary file sends only its size). null for
 * a reason the form does not take.
 */
export function artifactReportOf(
  answer: ReportAnswer,
  artifact: ReportedArtifact,
): ArtifactReport | null {
  if (!(reportFormCategories as readonly string[]).includes(answer.category))
    return null;
  const whole = artifact.blob ? "" : artifact.content;
  let content = whole.slice(0, artifactReportContentChars);
  // Never end on half of a character outside the Basic Multilingual Plane.
  if (content.length < whole.length && /[\uD800-\uDBFF]$/.test(content))
    content = content.slice(0, -1);
  const contentBytes = artifact.blob
    ? (artifact.bytes ?? 0)
    : content.length < whole.length
      ? new TextEncoder().encode(whole).length
      : 0;
  return {
    category: answer.category,
    ...(answer.notes ? { notes: answer.notes.slice(0, limits.notes) } : {}),
    ...(answer.reporterName ? { reporterName: answer.reporterName } : {}),
    ...(answer.reporterEmail ? { reporterEmail: answer.reporterEmail } : {}),
    identity: artifact.identity,
    title: artifact.title.slice(0, 400),
    language: artifact.language.slice(0, 32),
    content,
    ...(contentBytes ? { contentBytes } : {}),
  };
}

/** The last answer to "can Report artifact be sent", for the next opening. */
let lastReportsState: ArtifactReportsState | undefined;

/**
 * Whether Report artifact can be sent, asked each time the dialog opens
 * (the account or its administrator may have changed); undefined while the
 * first answer is on its way.
 */
export function useArtifactReportsState(
  asks: boolean,
): ArtifactReportsState | undefined {
  const [state, setState] = useState<ArtifactReportsState | undefined>(
    asks ? lastReportsState : "none",
  );
  useEffect(() => {
    const desktop = typeof window === "undefined" ? undefined : window.desktop;
    if (!asks || !desktop?.artifactReportsState) {
      setState("none");
      return;
    }
    let live = true;
    void desktop
      .artifactReportsState()
      .then((value) => {
        lastReportsState = value;
        if (live) setState(value);
      })
      .catch(() => {
        if (live) setState("none");
      });
    return () => {
      live = false;
    };
  }, [asks]);
  return state;
}

/**
 * Title menu → Report artifact: the live artifact viewer's report, which has
 * no training opt-out. It goes to the administrator of the account's Claudex
 * service with a copy of the artifact (`reportArtifact`); `onSent` gets the
 * toast's message. Without the artifact, on a local account, or with reports
 * turned off, Report stays disabled with the reason.
 */
export function ReportArtifactDialog({
  artifact,
  onSent,
  onClose,
}: {
  /** The artifact's name; the original's dialog does not show it. */
  name?: string;
  /** The artifact reported; without it nothing can be sent. */
  artifact?: ReportedArtifact;
  onSent?: (message: string) => void;
  onClose: () => void;
}) {
  const state = useArtifactReportsState(!!artifact);
  return (
    <ReportDialog
      title="Report Artifact"
      onClose={onClose}
      checking={state === undefined}
      unavailable={state === "off" ? reportsTurnedOff : reportUnavailable}
      submit={
        artifact && state === "open"
          ? async (answer) => {
              const report = artifactReportOf(answer, artifact);
              if (!report)
                throw new Error("Couldn’t send the report. Try again.");
              await window.desktop.reportArtifact(report);
              onSent?.("Report sent. Thank you.");
            }
          : undefined
      }
    />
  );
}
