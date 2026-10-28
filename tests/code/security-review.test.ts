import test from "node:test";
import assert from "node:assert/strict";
import {
  applyScan,
  applyTriage,
  emptyFindings,
  findingKeys,
  reportFromMessages,
  securityReviewInstructions,
  sortFindings,
  validTriage,
  type SecurityFindingsState,
} from "../../shared/security-review";
import { parseSecurityReport } from "../../shared/security-review-parse";
import {
  exportFilename,
  filterFindings,
  findingLocation,
  findingMarkdown,
  findingsCsv,
  findingsMarkdown,
} from "../../shared/security-review-export";

const report = `I looked through the project.

# Security review
Branch: main
Commit: 3f2a9c1

## Findings

### [High] SQL injection in the search handler
- File: src/search.ts:42-58
- CWE: CWE-89
- Category: SQL injection

**Description:** The query text is joined into the SQL string.
**Evidence:** \`buildQuery\` concatenates \`req.query.q\`.
**Impact:** An attacker can read any table.
**Reproduction steps:**
1. Open /search?q=' OR 1=1 --
2. Read the extra rows in the answer.
**Recommended fix:** Use a parameterized query.

### [Low] Verbose error page
- File: src/errors.ts:7
- Category: Information disclosure

**Description:** Stack traces are sent to the browser.
**Recommended fix:** Send a generic message in production.
`;

test("a report is read back into its findings", () => {
  const parsed = parseSecurityReport(report)!;
  assert.equal(parsed.branch, "main");
  assert.equal(parsed.commit, "3f2a9c1");
  assert.equal(parsed.findings.length, 2);
  const [first, second] = parsed.findings;
  assert.equal(first.severity, "high");
  assert.equal(first.title, "SQL injection in the search handler");
  assert.equal(first.file, "src/search.ts");
  assert.equal(first.start, 42);
  assert.equal(first.end, 58);
  assert.equal(first.cwe, "CWE-89");
  assert.equal(first.category, "SQL injection");
  assert.match(first.description, /joined into the SQL string/);
  assert.match(first.evidence, /buildQuery/);
  assert.match(first.impact, /read any table/);
  assert.deepEqual(first.steps, [
    "Open /search?q=' OR 1=1 --",
    "Read the extra rows in the answer.",
  ]);
  assert.equal(first.recommendation, "Use a parameterized query.");
  assert.equal(second.severity, "low");
  assert.equal(second.start, 7);
  assert.equal(second.end, undefined);
  assert.equal(second.cwe, undefined);
  assert.equal(findingLocation(first), "src/search.ts:42–58");
  assert.equal(findingLocation(second), "src/errors.ts:7");
});

test("a report with nothing in it is a report; other answers are not", () => {
  const none = parseSecurityReport(
    "# Security review\nBranch: dev\nCommit: abcdef1\n\n## Findings\n\nNo security findings.\n",
  );
  assert.deepEqual(none, { branch: "dev", commit: "abcdef1", findings: [] });
  assert.equal(parseSecurityReport("I could not read the folder."), undefined);
  assert.equal(parseSecurityReport(""), undefined);
  // The format's own template, copied back, names no branch.
  assert.equal(
    parseSecurityReport(
      "Branch: <branch name>\n## Findings\nNo security findings.",
    )?.branch,
    undefined,
  );
});

test("the last message that reads as a report is the report", () => {
  assert.equal(reportFromMessages(["Working on it", "Done."]), undefined);
  const found = reportFromMessages([report, "Anything else?"]);
  assert.equal(found?.findings.length, 2);
});

test("a heading inside a code fence is not a finding", () => {
  const fenced = parseSecurityReport(
    "## Findings\n\n```\n### [High] Not real\n```\n",
  );
  assert.deepEqual(fenced?.findings, []);
});

test("the instructions name the format the parser reads", () => {
  assert.match(securityReviewInstructions, /## Findings/);
  assert.match(securityReviewInstructions, /\*\*Recommended fix:\*\*/);
  assert.match(securityReviewInstructions, /No security findings\./);
});

test("findings of the same file and category share a key, told apart by order", () => {
  const [a, b] = parseSecurityReport(
    `## Findings\n### [High] One\n- File: a.ts:30\n- Category: XSS\n### [High] Two\n- File: a.ts:10\n- Category: XSS\n`,
  )!.findings;
  const keys = findingKeys([a, b]);
  assert.notEqual(keys[0], keys[1]);
  assert.ok(keys[1].endsWith("#0"), "the earlier line comes first");
  // The line moving does not change the key.
  assert.deepEqual(findingKeys([{ ...a, start: 99 }, b]), keys);
});

const parsed = parseSecurityReport(report)!;
const first: SecurityFindingsState = applyScan(emptyFindings(), {
  runId: "run-1",
  at: 1000,
  report: parsed,
});

test("a run adds its findings as open", () => {
  assert.equal(first.findings.length, 2);
  assert.ok(first.findings.every((finding) => finding.status === "open"));
  assert.equal(first.findings[0].branch, "main");
  assert.equal(first.findings[0].firstSeenAt, 1000);
  assert.deepEqual(first.scans[0], {
    runId: "run-1",
    at: 1000,
    branch: "main",
    commit: "3f2a9c1",
    readable: true,
    found: 2,
    added: 2,
    fixed: 0,
  });
  // The same run twice counts once.
  assert.equal(
    applyScan(first, { runId: "run-1", at: 2000, report: parsed }),
    first,
  );
});

test("a later run updates what it still reports and fixes what it no longer reports", () => {
  const second = applyScan(first, {
    runId: "run-2",
    at: 2000,
    report: {
      ...parsed,
      commit: "9999999",
      findings: [
        {
          ...parsed.findings[0],
          start: 50,
          end: 66,
          recommendation: "Bind it.",
        },
      ],
    },
  });
  const kept = second.findings.find((f) => f.title.startsWith("SQL"))!;
  const gone = second.findings.find((f) => f.title.startsWith("Verbose"))!;
  assert.equal(second.findings.length, 2);
  assert.equal(kept.status, "open");
  assert.equal(kept.start, 50);
  assert.equal(kept.recommendation, "Bind it.");
  assert.equal(kept.firstSeenAt, 1000);
  assert.equal(kept.lastSeenAt, 2000);
  assert.equal(kept.commit, "9999999");
  assert.equal(gone.status, "fixed");
  assert.equal(gone.fixedBy, "scan");
  assert.equal(gone.fixedAt, 2000);
  assert.equal(second.scans[0].fixed, 1);
  assert.equal(second.scans[0].added, 0);
});

test("a run on another branch does not fix the first branch's findings", () => {
  const other = applyScan(first, {
    runId: "run-2",
    at: 2000,
    report: { branch: "release", findings: [] },
  });
  assert.ok(other.findings.every((finding) => finding.status === "open"));
});

test("a run whose answer is not a report changes nothing", () => {
  const next = applyScan(first, { runId: "run-2", at: 2000 });
  assert.deepEqual(next.findings, first.findings);
  assert.equal(next.scans[0].readable, false);
  assert.ok(next.ingested.includes("run-2"));
});

test("a fixed finding that is reported again opens again; a dismissed one stays dismissed", () => {
  const id = first.findings[0].id;
  const other = first.findings[1].id;
  let state = applyTriage(first, id, { status: "fixed" }, 1500);
  assert.equal(state.findings.find((f) => f.id === id)!.fixedBy, "you");
  state = applyTriage(
    state,
    other,
    { status: "dismissed", reason: "false_finding" },
    1600,
  );
  state = applyScan(state, { runId: "run-2", at: 2000, report: parsed });
  const reopened = state.findings.find((f) => f.id === id)!;
  assert.equal(reopened.status, "open");
  assert.equal(reopened.fixedAt, undefined);
  const dismissed = state.findings.find((f) => f.id === other)!;
  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.dismissalReason, "false_finding");
  assert.equal(dismissed.lastSeenAt, 2000);
});

test("triage needs a note for an accepted risk and clears itself when opened", () => {
  const id = first.findings[0].id;
  assert.throws(
    () =>
      applyTriage(
        first,
        id,
        { status: "dismissed", reason: "accepted_risk" },
        1,
      ),
    /note is required/,
  );
  assert.throws(
    () =>
      applyTriage(
        first,
        id,
        { status: "dismissed", reason: "other", note: "   " },
        1,
      ),
    /note is required/,
  );
  const dismissed = applyTriage(
    first,
    id,
    { status: "dismissed", reason: "accepted_risk", note: "Behind the VPN." },
    5,
  );
  const item = dismissed.findings.find((f) => f.id === id)!;
  assert.equal(item.status, "dismissed");
  assert.equal(item.dismissalNote, "Behind the VPN.");
  assert.equal(item.triagedAt, 5);
  const restored = applyTriage(dismissed, id, { status: "open" }, 6);
  const back = restored.findings.find((f) => f.id === id)!;
  assert.equal(back.status, "open");
  assert.equal(back.dismissalReason, undefined);
  assert.equal(back.triagedAt, undefined);
  // The state it came from is not touched.
  assert.equal(first.findings[0].status, "open");
  assert.throws(
    () => applyTriage(first, "nope", { status: "fixed" }, 1),
    /no longer/,
  );
});

test("triage from the window is checked", () => {
  assert.deepEqual(validTriage({ status: "open" }), { status: "open" });
  assert.deepEqual(validTriage({ status: "dismissed", reason: "duplicate" }), {
    status: "dismissed",
    reason: "duplicate",
  });
  assert.throws(() => validTriage({ status: "dismissed", reason: "bogus" }));
  assert.throws(() => validTriage({ status: "gone" }));
  assert.throws(() => validTriage(null));
});

test("findings sort open first, then by severity, and filter by either", () => {
  const state = applyTriage(
    first,
    first.findings[0].id,
    { status: "fixed" },
    10,
  );
  const sorted = sortFindings(state.findings);
  assert.equal(sorted[0].status, "open");
  assert.equal(sorted[1].status, "fixed");
  assert.equal(
    filterFindings(state.findings, { severity: "low", status: "all" }).length,
    1,
  );
  assert.equal(
    filterFindings(state.findings, { severity: "all", status: "fixed" }).length,
    1,
  );
  assert.equal(
    filterFindings(state.findings, { severity: "high", status: "open" }).length,
    0,
  );
});

test("a finding exports as Markdown with its recommended fix and fields", () => {
  const text = findingMarkdown(first.findings[0], {
    routine: "Security review",
    folder: "/work/app",
  });
  assert.match(text, /^# SQL injection in the search handler/);
  assert.match(text, /## Recommended fix\nUse a parameterized query\./);
  assert.match(text, /\*\*Severity:\*\* High/);
  assert.match(text, /\*\*Status:\*\* Open/);
  assert.match(text, /\*\*CWE:\*\* CWE-89/);
  assert.match(text, /\*\*Branch:\*\* main/);
  assert.match(text, /1\. src\/search\.ts:42–58/);
  const all = findingsMarkdown(first.findings, { routine: "r" });
  assert.equal(all.split("\n\n---\n\n").length, 2);
});

test("the CSV has a header, a byte-order mark and harmless cells", () => {
  const tricky = applyScan(emptyFindings(), {
    runId: "x",
    at: Date.UTC(2026, 9, 12),
    report: {
      findings: [
        {
          ...parsed.findings[0],
          title: '=HYPERLINK("http://evil")',
          description: 'Has "quotes",\ncommas and a newline',
        },
      ],
    },
  });
  const csv = findingsCsv(tricky.findings, { routine: "Weekly" });
  assert.ok(csv.startsWith('﻿"ID","Severity"'));
  const rows = csv.slice(1).split("\r\n");
  assert.equal(rows.length, 2);
  assert.match(rows[1], /"'=HYPERLINK\(""http:\/\/evil""\)"/);
  assert.match(rows[1], /"Has ""quotes"", commas and a newline"/);
  assert.match(rows[1], /"2026-10-12"/);
});

test("export file names", () => {
  const at = Date.UTC(2026, 9, 12);
  assert.equal(
    exportFilename("Security review!", at),
    "security-review-findings-2026-10-12",
  );
  assert.equal(
    exportFilename("x", at, first.findings[0]),
    "sql-injection-in-the-search-handler",
  );
});
