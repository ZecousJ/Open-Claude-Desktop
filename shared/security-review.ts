import { parseSecurityReport } from "./security-review-parse"; /**
 * Security review routines: a routine that reviews a folder's branch for
 * vulnerabilities on a schedule and keeps what it finds as a list with a
 * status. The fields, statuses and exports follow the original's Security scan
 * findings; the scan itself is a Code run of the routine, so the model reports
 * in a fixed format (`securityReviewInstructions`) that `parseSecurityReport`
 * reads back and `applyScan` merges into the list.
 */

export const severities = ["critical", "high", "medium", "low"] as const;
export type FindingSeverity = (typeof severities)[number];
export const severityLabels: Record<FindingSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const findingStatuses = ["open", "fixed", "dismissed"] as const;
export type FindingStatus = (typeof findingStatuses)[number];
export const findingStatusLabels: Record<FindingStatus, string> = {
  open: "Open",
  fixed: "Fixed",
  dismissed: "Dismissed",
};

/** Why a finding is dismissed (the original's triage reasons). */
export type DismissalReason =
  | "false_finding"
  | "unreachable_code"
  | "not_production"
  | "works_as_intended"
  | "validated_elsewhere"
  | "trusted_source"
  | "duplicate"
  | "accepted_risk"
  | "other";
export const dismissalLabels: Record<DismissalReason, string> = {
  false_finding: "False finding",
  unreachable_code: "Unreachable code",
  not_production: "Not production code",
  works_as_intended: "Works as intended",
  validated_elsewhere: "Validated elsewhere",
  trusted_source: "Trusted source",
  duplicate: "Duplicate",
  accepted_risk: "Accepted risk",
  other: "Other",
};
/** The Triage menu's groups, as the original lays them out. */
export const dismissalGroups: {
  heading: string;
  reasons: DismissalReason[];
}[] = [
  {
    heading: "Not applicable",
    reasons: [
      "false_finding",
      "unreachable_code",
      "not_production",
      "works_as_intended",
    ],
  },
  {
    heading: "Handled elsewhere",
    reasons: ["validated_elsewhere", "trusted_source", "duplicate"],
  },
  { heading: "Acknowledged", reasons: ["accepted_risk", "other"] },
];
/** Accepting a risk or dismissing for another reason needs a note. */
export const dismissalNeedsNote = (reason: DismissalReason) =>
  reason === "accepted_risk" || reason === "other";

/** What the person can do with a finding. */
export type FindingTriage =
  | { status: "open" }
  | { status: "fixed" }
  | { status: "dismissed"; reason: DismissalReason; note?: string };

/** One problem as the model reported it in a run. */
export interface ReportedFinding {
  title: string;
  severity: FindingSeverity;
  /** The file, relative to the routine's folder. */
  file?: string;
  start?: number;
  end?: number;
  cwe?: string;
  category?: string;
  description: string;
  evidence: string;
  impact: string;
  steps: string[];
  recommendation: string;
}

export interface SecurityReport {
  branch?: string;
  commit?: string;
  findings: ReportedFinding[];
}

/** A finding as the list keeps it from one run to the next. */
export interface SecurityFinding extends ReportedFinding {
  id: string;
  status: FindingStatus;
  branch?: string;
  commit?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** When the scan stopped reporting it, or when the person marked it fixed. */
  fixedAt?: number;
  fixedBy?: "scan" | "you";
  /** When the person dismissed it. */
  triagedAt?: number;
  dismissalReason?: DismissalReason;
  dismissalNote?: string;
}

/** One run's contribution to the list. */
export interface SecurityScan {
  runId: string;
  at: number;
  branch?: string;
  commit?: string;
  /** False when the run's answer was not a report (nothing changed). */
  readable: boolean;
  found: number;
  added: number;
  fixed: number;
}

export interface SecurityFindingsState {
  scans: SecurityScan[];
  /** Runs already merged, so a run counts once. */
  ingested: string[];
  findings: SecurityFinding[];
}

/** What the window gets: the list, best first, and the runs behind it. */
export interface SecurityFindingsView {
  findings: SecurityFinding[];
  scans: SecurityScan[];
}

export const emptyFindings = (): SecurityFindingsState => ({
  scans: [],
  ingested: [],
  findings: [],
});

export const findingLimit = 2000;
export const scanLimit = 50;

/** A routine's instructions for the review and the format its answer must take. */
export const securityReviewInstructions = `Do a security review of the branch that is checked out in this folder. Read the code for weaknesses an attacker could use: injection, broken authentication or access control, unsafe deserialization, path traversal, server-side request forgery, cross-site scripting, hard-coded secrets, weak cryptography, insecure configuration and unsafe dependencies. Report only what you can point to in the code, and read the code around it before you call something exploitable. Do not change any files. Use git to find the branch name and the commit you reviewed.

Write your answer as a report in exactly this format, so each run can be compared with the last:

# Security review
Branch: <branch name>
Commit: <short commit hash>

## Findings

### [Critical|High|Medium|Low] <short title>
- File: <path relative to this folder>:<first line>-<last line>
- CWE: <CWE-number, if one fits>
- Category: <for example SQL injection>

**Description:** <what is wrong>
**Evidence:** <what in the code shows it>
**Impact:** <what an attacker gains>
**Reproduction steps:**
1. <step>
**Recommended fix:** <what to change>

Use the same title, category and file for a problem you would report on every run, so it keeps its history. If you find nothing, write "No security findings." under "## Findings".`;

/**
 * The report in the last answer of a run's first turn: the last assistant
 * message that reads as one (a run may say something before the report).
 */
export function reportFromMessages(
  texts: string[],
): SecurityReport | undefined {
  for (let index = texts.length - 1; index >= 0; index--) {
    const report = parseSecurityReport(texts[index]);
    if (report) return report;
  }
  return undefined;
}

// ---- Keeping the list

/** 53-bit string hash (cyrb53): the same on every platform, short enough to read. */
function hash(text: string) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0))
    .toString(16)
    .padStart(14, "0");
}

const normal = (value: string | undefined) =>
  (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Which findings of two runs are the same problem: the file and the
 * category (else the title), not the line, which moves. Two reports with
 * the same file and category are told apart by their order in the file.
 */
export function findingKeys(findings: ReportedFinding[]): string[] {
  const order = findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        (a.finding.start ?? 0) - (b.finding.start ?? 0) || a.index - b.index,
    );
  const seen = new Map<string, number>();
  const keys: string[] = [];
  for (const { finding, index } of order) {
    const base = `${normal(finding.file)}|${normal(finding.category) || normal(finding.title)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    keys[index] = `${base}#${count}`;
  }
  return keys;
}

const sameScope = (a: string | undefined, b: string | undefined) =>
  !a || !b || a === b;

/**
 * Merges one run into the list. A reported problem is added as Open, or
 * updated (a fixed one that is reported again opens again; a dismissed one
 * stays dismissed). An open problem on the same branch that the run no
 * longer reports is Fixed. A run without a readable report changes nothing
 * but is remembered, so it is not read again.
 */
export function applyScan(
  state: SecurityFindingsState,
  scan: { runId: string; at: number; report?: SecurityReport },
): SecurityFindingsState {
  if (state.ingested.includes(scan.runId)) return state;
  const next: SecurityFindingsState = {
    scans: state.scans.slice(),
    ingested: [...state.ingested, scan.runId].slice(-500),
    findings: state.findings.map((finding) => ({ ...finding })),
  };
  const report = scan.report;
  if (!report) {
    next.scans.unshift({
      runId: scan.runId,
      at: scan.at,
      readable: false,
      found: 0,
      added: 0,
      fixed: 0,
    });
    next.scans = next.scans.slice(0, scanLimit);
    return next;
  }
  const keys = findingKeys(report.findings);
  const reported = new Set<string>();
  let added = 0;
  report.findings.forEach((item, index) => {
    const key = keys[index];
    const id = hash(key);
    reported.add(id);
    const existing = next.findings.find((finding) => finding.id === id);
    if (existing) {
      // What the run says now replaces what it said before; the status stays.
      for (const field of ["file", "start", "end", "cwe", "category"] as const)
        delete existing[field];
      Object.assign(existing, item, {
        lastSeenAt: scan.at,
        branch: report.branch ?? existing.branch,
        commit: report.commit ?? existing.commit,
      });
      // Reported again, a finding thought fixed is open again.
      if (existing.status === "fixed") {
        existing.status = "open";
        delete existing.fixedAt;
        delete existing.fixedBy;
      }
      return;
    }
    if (next.findings.length >= findingLimit) return;
    added++;
    next.findings.push({
      ...item,
      id,
      status: "open",
      ...(report.branch ? { branch: report.branch } : {}),
      ...(report.commit ? { commit: report.commit } : {}),
      firstSeenAt: scan.at,
      lastSeenAt: scan.at,
    });
  });
  let fixed = 0;
  for (const finding of next.findings)
    if (
      finding.status === "open" &&
      !reported.has(finding.id) &&
      sameScope(finding.branch, report.branch)
    ) {
      finding.status = "fixed";
      finding.fixedAt = scan.at;
      finding.fixedBy = "scan";
      fixed++;
    }
  next.scans.unshift({
    runId: scan.runId,
    at: scan.at,
    ...(report.branch ? { branch: report.branch } : {}),
    ...(report.commit ? { commit: report.commit } : {}),
    readable: true,
    found: report.findings.length,
    added,
    fixed,
  });
  next.scans = next.scans.slice(0, scanLimit);
  return next;
}

/** Marks a finding fixed, dismisses it with a reason, or opens it again. */
export function applyTriage(
  state: SecurityFindingsState,
  findingId: string,
  triage: FindingTriage,
  at: number,
): SecurityFindingsState {
  const finding = state.findings.find((value) => value.id === findingId);
  if (!finding) throw new Error("This finding no longer exists.");
  const next: SecurityFindingsState = {
    ...state,
    findings: state.findings.map((value) =>
      value.id === findingId ? { ...value } : value,
    ),
  };
  const target = next.findings.find((value) => value.id === findingId)!;
  for (const key of [
    "fixedAt",
    "fixedBy",
    "triagedAt",
    "dismissalReason",
    "dismissalNote",
  ] as const)
    delete target[key];
  if (triage.status === "open") {
    target.status = "open";
  } else if (triage.status === "fixed") {
    target.status = "fixed";
    target.fixedAt = at;
    target.fixedBy = "you";
  } else {
    if (!(triage.reason in dismissalLabels))
      throw new Error("Choose why this finding is dismissed.");
    const note = triage.note?.trim() ?? "";
    if (dismissalNeedsNote(triage.reason) && !note)
      throw new Error("A note is required for this dismissal reason.");
    target.status = "dismissed";
    target.triagedAt = at;
    target.dismissalReason = triage.reason;
    if (note) target.dismissalNote = note.slice(0, 2000);
  }
  return next;
}

/** Validates a triage from the window. */
export function validTriage(value: unknown): FindingTriage {
  const triage = value as Partial<Record<string, unknown>> | null;
  if (!triage || typeof triage !== "object")
    throw new Error("Choose what to do with this finding.");
  if (triage.status === "open") return { status: "open" };
  if (triage.status === "fixed") return { status: "fixed" };
  if (
    triage.status === "dismissed" &&
    typeof triage.reason === "string" &&
    triage.reason in dismissalLabels
  )
    return {
      status: "dismissed",
      reason: triage.reason as DismissalReason,
      ...(typeof triage.note === "string" ? { note: triage.note } : {}),
    };
  throw new Error("Choose what to do with this finding.");
}

const severityRank = (finding: SecurityFinding) =>
  severities.indexOf(finding.severity);
const statusRank = (finding: SecurityFinding) =>
  findingStatuses.indexOf(finding.status);

/** Open ones first, then by severity, then the newest. */
export function sortFindings(findings: SecurityFinding[]): SecurityFinding[] {
  return findings
    .slice()
    .sort(
      (a, b) =>
        statusRank(a) - statusRank(b) ||
        severityRank(a) - severityRank(b) ||
        b.firstSeenAt - a.firstSeenAt ||
        a.title.localeCompare(b.title),
    );
}
