/**
 * The text Codex ends a review with (`exitedReviewMode.review`): its overall
 * explanation, then the findings as Codex renders them
 * (codex-rs `render_review_output_text`):
 *
 *     <explanation>
 *
 *     Full review comments:        (or "Review comment:" for one finding)
 *
 *     - [P1] Title — /abs/path.ts:12-14
 *       body line
 *       body line
 *
 * A review that produced nothing reads "Reviewer failed to output a
 * response." The app-server gives only this text, so the findings are read
 * back out of it; a text that does not look like that is shown as it is.
 */

export interface ReviewFinding {
  title: string;
  /** 0 (most urgent) to 3, from a leading "[P1]" in the title. */
  priority?: number;
  /** The file as Codex wrote it (an absolute path). */
  path: string;
  start?: number;
  end?: number;
  body: string;
}

export interface ReviewOutput {
  /** The overall explanation (everything before the findings). */
  summary: string;
  findings: ReviewFinding[];
  /** Codex gave no answer at all. */
  failed: boolean;
}

const failure = "Reviewer failed to output a response.";
const header = /(?:^|\n\n)(?:Full review comments|Review comment):[ \t]*\n/;
const finding = /^- (?:\[[ xX]\] )?(.+)$/;
const location = /^(.*) — (.+?)(?::(\d+)(?:-(\d+))?)?$/;

function parseFinding(title: string, body: string[]): ReviewFinding {
  const match = location.exec(title);
  const heading = (match ? match[1] : title).trim();
  const priority = /^\[P([0-3])\]\s*/.exec(heading);
  return {
    title: heading.replace(/^\[P[0-3]\]\s*/, ""),
    ...(priority ? { priority: Number(priority[1]) } : {}),
    path: match ? match[2].trim() : "",
    ...(match?.[3] ? { start: Number(match[3]) } : {}),
    ...(match?.[4] ? { end: Number(match[4]) } : {}),
    body: body
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n")
      .trim(),
  };
}

export function parseReviewOutput(text: string): ReviewOutput {
  const value = text.trim();
  if (!value || value === failure)
    return { summary: "", findings: [], failed: true };
  const split = header.exec(value);
  if (!split) return { summary: value, findings: [], failed: false };
  const summary = value.slice(0, split.index).trim();
  const lines = value.slice(split.index + split[0].length).split("\n");
  const findings: ReviewFinding[] = [];
  let title: string | undefined;
  let body: string[] = [];
  const close = () => {
    if (title !== undefined) findings.push(parseFinding(title, body));
    title = undefined;
    body = [];
  };
  for (const line of lines) {
    const start = finding.exec(line);
    if (start) {
      close();
      title = start[1];
    } else if (title !== undefined) body.push(line);
  }
  close();
  // The header without a finding under it is just text.
  if (!findings.length) return { summary: value, findings: [], failed: false };
  return { summary, findings, failed: false };
}

/** The findings grouped by file, in the order the files first appear. */
export function findingsByFile(findings: ReviewFinding[]) {
  const groups = new Map<string, { finding: ReviewFinding; index: number }[]>();
  findings.forEach((item, index) => {
    const list = groups.get(item.path);
    if (list) list.push({ finding: item, index });
    else groups.set(item.path, [{ finding: item, index }]);
  });
  return [...groups].map(([path, entries]) => ({ path, entries }));
}

/** The file's last path segment, for the group heading. */
export const fileName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path;
