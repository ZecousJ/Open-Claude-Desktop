import {
  severityLabels,
  findingStatusLabels,
  dismissalLabels,
  sortFindings,
} from "./security-review";
import type {
  FindingSeverity,
  FindingStatus,
  ReportedFinding,
  SecurityFinding,
} from "./security-review";

export interface FindingFilter {
  severity: FindingSeverity | "all";
  status: FindingStatus | "all";
}

export const defaultFindingFilter: FindingFilter = {
  severity: "all",
  status: "all",
};

export function filterFindings(
  findings: SecurityFinding[],
  filter: FindingFilter,
) {
  return findings.filter(
    (finding) =>
      (filter.severity === "all" || finding.severity === filter.severity) &&
      (filter.status === "all" || finding.status === filter.status),
  );
}

/** "src/a.ts:12-14". */
export function findingLocation(finding: ReportedFinding) {
  if (!finding.file) return "";
  if (finding.start === undefined) return finding.file;
  return `${finding.file}:${finding.start}${finding.end && finding.end !== finding.start ? `–${finding.end}` : ""}`;
}

// ---- Export (the original's Markdown and CSV)

export type FindingsFormat = "markdown" | "csv";

export interface ExportContext {
  /** The routine's name and folder, for the exports' header lines. */
  routine: string;
  folder?: string;
}

const day = (time: number | undefined) =>
  time === undefined || !Number.isFinite(time)
    ? ""
    : new Date(time).toISOString().slice(0, 10);

/** One finding as the original writes it: details, evidence, impact, steps, the fix, then the fields. */
export function findingMarkdown(
  finding: SecurityFinding,
  context: ExportContext,
): string {
  const out: string[] = [`# ${finding.title}`, ""];
  out.push("## Details", finding.description || "No description.", "");
  const where = findingLocation(finding);
  if (where || finding.evidence) {
    out.push("## Evidence");
    if (where) out.push(`1. ${where}`);
    if (finding.evidence)
      out.push(where ? `   ${finding.evidence}` : finding.evidence);
    out.push("");
  }
  if (finding.impact) out.push("## Impact", finding.impact, "");
  if (finding.steps.length) {
    out.push("## Reproduction steps");
    finding.steps.forEach((step, index) => out.push(`${index + 1}. ${step}`));
    out.push("");
  }
  if (finding.recommendation)
    out.push("## Recommended fix", finding.recommendation, "");
  out.push("---");
  const field = (name: string, value: string | undefined) => {
    if (value) out.push(`**${name}:** ${value}`);
  };
  field("Severity", severityLabels[finding.severity]);
  field("Status", findingStatusLabels[finding.status]);
  field("Category", finding.category);
  field("CWE", finding.cwe);
  field("Routine", context.routine);
  field("Folder", context.folder);
  field("Branch", finding.branch ?? "Unknown");
  field("Commit", finding.commit);
  field("First seen", day(finding.firstSeenAt));
  field("Fixed on", day(finding.fixedAt));
  field("Triaged on", day(finding.triagedAt));
  field(
    "Dismissal reason",
    finding.dismissalReason && dismissalLabels[finding.dismissalReason],
  );
  field("Dismissal note", finding.dismissalNote);
  return out.join("\n");
}

export function findingsMarkdown(
  findings: SecurityFinding[],
  context: ExportContext,
) {
  return sortFindings(findings)
    .map((finding) => findingMarkdown(finding, context))
    .join("\n\n---\n\n");
}

/** A CSV cell: quoted, and a leading = + - @ made harmless for spreadsheets. */
function cell(value: string | number | undefined) {
  let text = value === undefined ? "" : String(value);
  text = text
    .replace(/\r\n?|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const csvColumns: [
  string,
  (
    finding: SecurityFinding,
    context: ExportContext,
  ) => string | number | undefined,
][] = [
  ["ID", (finding) => finding.id],
  ["Severity", (finding) => severityLabels[finding.severity]],
  ["Status", (finding) => findingStatusLabels[finding.status]],
  ["First seen", (finding) => day(finding.firstSeenAt)],
  ["Category", (finding) => finding.category],
  ["Routine", (_, context) => context.routine],
  ["Branch", (finding) => finding.branch ?? "Unknown"],
  ["Name", (finding) => finding.title],
  ["Description", (finding) => finding.description],
  ["File path", (finding) => finding.file],
  ["Line", (finding) => finding.start],
  ["CWE", (finding) => finding.cwe],
  [
    "Dismissal reason",
    (finding) =>
      finding.dismissalReason && dismissalLabels[finding.dismissalReason],
  ],
  ["Dismissal note", (finding) => finding.dismissalNote],
  ["Evidence", (finding) => finding.evidence],
  ["Impact", (finding) => finding.impact],
  [
    "Reproduction steps",
    (finding) =>
      finding.steps.map((step, index) => `${index + 1}. ${step}`).join("; "),
  ],
  ["Recommended fix", (finding) => finding.recommendation],
  ["Fixed on", (finding) => day(finding.fixedAt)],
  ["Triaged on", (finding) => day(finding.triagedAt)],
  ["Commit", (finding) => finding.commit],
];

export function findingsCsv(
  findings: SecurityFinding[],
  context: ExportContext,
) {
  const rows = [csvColumns.map(([name]) => cell(name)).join(",")];
  for (const finding of sortFindings(findings))
    rows.push(
      csvColumns.map(([, value]) => cell(value(finding, context))).join(","),
    );
  // A leading byte-order mark makes spreadsheets read the file as UTF-8.
  return `﻿${rows.join("\r\n")}`;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** "{routine}-findings-2026-10-12", or the finding's own name for one finding. */
export function exportFilename(
  routine: string,
  at: number,
  single?: SecurityFinding,
) {
  if (single)
    return slug(single.title) || slug(single.category ?? "") || "finding";
  return `${slug(routine) || "security-review"}-findings-${day(at)}`;
}
