import { ChevronLeft } from "../../../ui/glyphs";
import {
  dismissalLabels,
  findingStatusLabels,
  severityLabels,
  type SecurityFinding,
} from "../../../../shared/security-review";
import { findingLocation } from "../../../../shared/security-review-export";
import { currentLocale } from "../../../i18n";
import { Markdown } from "../../../ui/Markdown";

const day = (time: number) =>
  new Date(time).toLocaleDateString(currentLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** A section of the detail: the model's own text, shown as Markdown. */
function Section({ title, text }: { title: string; text: string }) {
  if (!text) return null;
  return (
    <section className="sec-section">
      <h3>{title}</h3>
      <div className="markdown">
        <Markdown text={text} />
      </div>
    </section>
  );
}

/**
 * One finding in full: Triage (or Restore once triaged) and Export finding at
 * the top; then Details, Evidence, Impact, Reproduction steps and Recommended
 * fix, and the fields. A finding's text is what the review wrote, so it is not
 * put through the interface translation.
 */
export function FindingDetail({
  finding,
  busy,
  status,
  error,
  onBack,
  onTriageMenu,
  onExportMenu,
  onRestore,
}: {
  finding: SecurityFinding;
  busy: boolean;
  /** A line that says what just happened (Copied to clipboard, Finding triaged). */
  status: string;
  error: string;
  onBack: () => void;
  onTriageMenu: (button: HTMLButtonElement) => void;
  onExportMenu: (button: HTMLButtonElement) => void;
  onRestore: () => void;
}) {
  const where = findingLocation(finding);
  const rows: [string, string | undefined, boolean?][] = [
    ["Severity", severityLabels[finding.severity]],
    ["Status", findingStatusLabels[finding.status]],
    ["Category", finding.category, true],
    ["CWE", finding.cwe, true],
    ["Branch", finding.branch, true],
    ["Commit", finding.commit, true],
    ["First seen", day(finding.firstSeenAt)],
    ["Last seen", day(finding.lastSeenAt)],
    [
      "Fixed on",
      finding.fixedAt === undefined ? undefined : day(finding.fixedAt),
    ],
    [
      "Fixed by",
      finding.fixedBy === "scan"
        ? "A later scan"
        : finding.fixedBy === "you"
          ? "You"
          : undefined,
    ],
    [
      "Triaged on",
      finding.triagedAt === undefined ? undefined : day(finding.triagedAt),
    ],
    [
      "Dismissal reason",
      finding.dismissalReason && dismissalLabels[finding.dismissalReason],
    ],
    ["Dismissal note", finding.dismissalNote, true],
  ];
  return (
    <div className="sec-detail">
      <div className="sec-detail-bar">
        <button type="button" className="sec-back" onClick={onBack}>
          <ChevronLeft size={14} strokeWidth={1.8} />
          All findings
        </button>
        <span className="sec-grow" />
        {finding.status === "open" ? (
          <button
            type="button"
            className="secondary sec-button"
            aria-haspopup="menu"
            disabled={busy}
            onClick={(event) => onTriageMenu(event.currentTarget)}
          >
            Triage
          </button>
        ) : (
          <button
            type="button"
            className="secondary sec-button"
            disabled={busy}
            onClick={onRestore}
          >
            Restore
          </button>
        )}
        <button
          type="button"
          className="secondary sec-button"
          aria-haspopup="menu"
          onClick={(event) => onExportMenu(event.currentTarget)}
        >
          Export finding
        </button>
      </div>
      <h3 className="sec-title" data-no-translate>
        <span className={`sec-severity ${finding.severity}`}>
          {severityLabels[finding.severity]}
        </span>
        {finding.title}
      </h3>
      {status && (
        <p className="sec-status-line" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="routine-error" role="alert">
          {error}
        </p>
      )}
      <Section title="Details" text={finding.description} />
      {(where || finding.evidence) && (
        <section className="sec-section">
          <h3>Evidence</h3>
          {where && (
            <p className="sec-where" data-no-translate>
              {where}
            </p>
          )}
          {finding.evidence && (
            <div className="markdown">
              <Markdown text={finding.evidence} />
            </div>
          )}
        </section>
      )}
      <Section title="Impact" text={finding.impact} />
      {finding.steps.length > 0 && (
        <section className="sec-section">
          <h3>Reproduction steps</h3>
          <ol className="sec-steps" data-no-translate>
            {finding.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </section>
      )}
      <Section title="Recommended fix" text={finding.recommendation} />
      <dl className="sec-fields">
        {rows.map(
          ([name, value, own]) =>
            value && (
              <div key={name}>
                <dt>{name}</dt>
                <dd data-no-translate={own || undefined}>{value}</dd>
              </div>
            ),
        )}
      </dl>
    </div>
  );
}
