import type {
  FindingSeverity,
  ReportedFinding,
  SecurityReport,
} from "./security-review";

// ---- Reading the report

const sectionLabels: Record<
  string,
  "description" | "evidence" | "impact" | "steps" | "recommendation"
> = {
  description: "description",
  details: "description",
  evidence: "evidence",
  impact: "impact",
  "reproduction steps": "steps",
  "exploit scenario": "steps",
  "recommended fix": "recommendation",
  recommendation: "recommendation",
  fix: "recommendation",
};

const sectionLine =
  /^\s*\*{0,2}(Description|Details|Evidence|Impact|Reproduction steps|Exploit scenario|Recommended fix|Recommendation|Fix)\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/i;

const metaLine =
  /^\s*[-*]\s*\*{0,2}(File|CWE|Category)\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/i;

const headingLine =
  /^#{2,4}\s+(?:\[(critical|high|medium|low)\]|(critical|high|medium|low)\s*[:–—-])\s*(.+?)\s*#*\s*$/i;

const findingsHeading = /^#{1,3}\s*Findings\s*$/im;

/** Control characters out, length bounded: a report is model output. */
function clean(value: string, limit: number) {
  // eslint-disable-next-line no-control-regex
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, limit);
}

function parseLocation(text: string) {
  const value = text.replace(/`/g, "").trim();
  const match = /^(.*?):(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(value);
  if (!match) return { file: value || undefined };
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : undefined;
  return {
    file: match[1].trim() || undefined,
    start,
    ...(end !== undefined && end >= start ? { end } : {}),
  };
}

function parseBlock(
  severity: FindingSeverity,
  title: string,
  lines: string[],
): ReportedFinding {
  const sections: Record<string, string[]> = {};
  const lead: string[] = [];
  let meta: { file?: string; start?: number; end?: number } = {};
  let cwe: string | undefined;
  let category: string | undefined;
  let current: string | undefined;
  for (const line of lines) {
    const label = sectionLine.exec(line);
    if (label) {
      current = sectionLabels[label[1].toLowerCase()];
      (sections[current] ??= []).push(label[2]);
      continue;
    }
    const field = current === undefined ? metaLine.exec(line) : null;
    if (field) {
      const name = field[1].toLowerCase();
      if (name === "file") meta = parseLocation(field[2]);
      else if (name === "cwe")
        cwe = /CWE-\d+/i.exec(field[2])?.[0].toUpperCase();
      else category = clean(field[2].replace(/`/g, ""), 120) || undefined;
      continue;
    }
    if (current === undefined) lead.push(line);
    else sections[current].push(line);
  }
  const text = (name: string) => clean((sections[name] ?? []).join("\n"), 8000);
  const steps = (sections.steps ?? [])
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((step) => clean(step, 1000));
  return {
    title: clean(title.replace(/[*`]/g, ""), 300),
    severity,
    ...(meta.file ? { file: clean(meta.file, 500) } : {}),
    ...(meta.start !== undefined ? { start: meta.start } : {}),
    ...(meta.end !== undefined ? { end: meta.end } : {}),
    ...(cwe ? { cwe } : {}),
    ...(category ? { category } : {}),
    description: text("description") || clean(lead.join("\n"), 8000),
    evidence: text("evidence"),
    impact: text("impact"),
    steps,
    recommendation: text("recommendation"),
  };
}

/**
 * Reads a run's answer. Undefined when it is not a report (no "Findings"
 * section and no finding headings), so the run changes nothing; a report
 * that says there is nothing has an empty list.
 */
export function parseSecurityReport(text: string): SecurityReport | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const found: ReportedFinding[] = [];
  let heading: { severity: FindingSeverity; title: string } | undefined;
  let block: string[] = [];
  const header: string[] = [];
  let seenFindings = false;
  let inFence = false;
  const close = () => {
    if (heading && found.length < reportLimit)
      found.push(parseBlock(heading.severity, heading.title, block));
    heading = undefined;
    block = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = inFence ? null : headingLine.exec(line);
    if (match) {
      close();
      heading = {
        severity: (match[1] ?? match[2]).toLowerCase() as FindingSeverity,
        title: match[3],
      };
      continue;
    }
    if (!inFence && findingsHeading.test(line)) {
      close();
      seenFindings = true;
      continue;
    }
    if (heading) block.push(line);
    else if (!seenFindings) header.push(line);
  }
  close();
  const hasHeading = lines.some((line) => findingsHeading.test(line));
  const saysNone = /\bno security (findings|issues|vulnerabilities)\b/i.test(
    text,
  );
  if (!hasHeading && !saysNone && !found.length) return undefined;
  const top = header.join("\n");
  const branch = /^\s*\**Branch\**\s*:\s*\**\s*`?([^`\n]+?)`?\s*$/im.exec(
    top,
  )?.[1];
  const commit = /^\s*\**Commit\**\s*:\s*\**\s*`?([0-9a-f]{4,64})\b/im.exec(
    top,
  )?.[1];
  return {
    ...(branch && !/^<.*>$/.test(branch.trim())
      ? { branch: clean(branch, 200) }
      : {}),
    ...(commit ? { commit: commit.toLowerCase() } : {}),
    findings: found.filter((finding) => finding.title),
  };
}

export const reportLimit = 100;
