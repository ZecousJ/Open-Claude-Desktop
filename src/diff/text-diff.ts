import { parseUnifiedDiff, type DiffFile } from "./diff-model";

/*
 * A line diff of two texts, for comparing two versions of a file (the version
 * switcher's "Compare with current"). The edits are found with Myers' algorithm
 * and written as a unified diff that the shared parser (diff-model.ts) turns
 * into numbered hunks, so the rows, the word emphasis and the counts are the
 * Changes panel's own. Like the original's compare, it gives up on texts that
 * differ too much ("Too large to compare"): more than 1000 changed lines or
 * about 250ms.
 */

/** The original's limit on changed lines before a compare is refused. */
export const maxEditLength = 1000;
/** Lines of context around each change, as `git diff` shows. */
const CONTEXT = 3;
/** The original stops a compare after this many milliseconds. */
const TIME_BUDGET_MS = 250;

type Edit = { kind: "context" | "add" | "del"; text: string };

export function lineEdits(before: string[], after: string[]) {
  return edits(before, after, maxEditLength, Date.now() + TIME_BUDGET_MS);
}

function lines(text: string) {
  const all = text.replace(/\r\n/g, "\n").split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
}

/**
 * The edits that turn `a` into `b`, or undefined when more than
 * `maxEdits` lines differ or `deadline` passes first.
 */
function edits(
  a: string[],
  b: string[],
  maxEdits: number,
  deadline: number,
): Edit[] | undefined {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = middleEdits(
    a.slice(start, endA),
    b.slice(start, endB),
    maxEdits,
    deadline,
  );
  if (!middle) return undefined;
  return [
    ...a.slice(0, start).map((text): Edit => ({ kind: "context", text })),
    ...middle,
    ...a.slice(endA).map((text): Edit => ({ kind: "context", text })),
  ];
}

/** Myers' O(ND) shortest edit script between two lists with no common ends. */
function middleEdits(
  a: string[],
  b: string[],
  maxEdits: number,
  deadline: number,
): Edit[] | undefined {
  const n = a.length,
    m = b.length;
  if (!n) return b.map((text) => ({ kind: "add", text }));
  if (!m) return a.map((text) => ({ kind: "del", text }));
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    if ((d & 63) === 0 && Date.now() > deadline) return undefined;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return undefined;
  // Walk back from the end through the saved frontiers.
  const out: Edit[] = [];
  let x = n,
    y = m;
  for (let d = found; d > 0; d--) {
    const previous = trace[d];
    const k = x - y;
    const down =
      k === -d ||
      (k !== d && previous[offset + k - 1] < previous[offset + k + 1]);
    const previousK = down ? k + 1 : k - 1;
    const previousX = previous[offset + previousK];
    const previousY = previousX - previousK;
    while (
      x > (down ? previousX : previousX + 1) &&
      y > (down ? previousY + 1 : previousY)
    ) {
      x--;
      y--;
      out.push({ kind: "context", text: a[x] });
    }
    if (down) out.push({ kind: "add", text: b[--y] });
    else out.push({ kind: "del", text: a[--x] });
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    out.push({ kind: "context", text: a[x] });
  }
  return out.reverse();
}

/** The edits as the hunks of a unified diff, each change with CONTEXT lines around it. */
function unified(path: string, all: Edit[]) {
  const changed = all
    .map((edit, index) => (edit.kind === "context" ? -1 : index))
    .filter((index) => index >= 0);
  if (!changed.length) return "";
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const from = Math.max(0, index - CONTEXT),
      to = Math.min(all.length, index + CONTEXT + 1);
    const last = ranges.at(-1);
    if (last && from <= last[1]) last[1] = to;
    else ranges.push([from, to]);
  }
  // Line numbers before each edit, to number the hunks.
  const before: number[] = [],
    after: number[] = [];
  let oldNo = 1,
    newNo = 1;
  for (const edit of all) {
    before.push(oldNo);
    after.push(newNo);
    if (edit.kind !== "add") oldNo++;
    if (edit.kind !== "del") newNo++;
  }
  let text = `--- a/${path}\n+++ b/${path}\n`;
  for (const [from, to] of ranges) {
    const slice = all.slice(from, to);
    const oldLines = slice.filter((edit) => edit.kind !== "add").length;
    const newLines = slice.filter((edit) => edit.kind !== "del").length;
    text += `@@ -${oldLines ? before[from] : before[from] - 1},${oldLines} +${newLines ? after[from] : after[from] - 1},${newLines} @@\n`;
    for (const edit of slice)
      text += `${edit.kind === "add" ? "+" : edit.kind === "del" ? "-" : " "}${edit.text}\n`;
  }
  return text;
}

/**
 * What changed from `before` to `after`, as a file with hunks of numbered
 * lines (empty when only line endings differ); undefined when the texts
 * differ too much to compare.
 */
export function diffTexts(
  before: string,
  after: string,
  path = "",
  { maxEdits = maxEditLength, budgetMs = TIME_BUDGET_MS } = {},
): DiffFile | undefined {
  const script = edits(
    lines(before),
    lines(after),
    maxEdits,
    Date.now() + budgetMs,
  );
  if (!script) return undefined;
  const text = unified(path, script);
  return (
    parseUnifiedDiff(text, path)[0] ?? {
      path,
      status: "modified",
      hunks: [],
      additions: 0,
      deletions: 0,
    }
  );
}
