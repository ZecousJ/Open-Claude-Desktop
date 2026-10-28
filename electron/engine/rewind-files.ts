import fs from "node:fs";
import path from "node:path";
import type { RewindChange } from "../../shared/rewind-files";

/**
 * Undoes Claude's file edits for Rewind's "Code" restore, newest first: an
 * added file is removed, a deleted one written back, an edit's diff applied
 * in reverse (a moved file goes back to its old name). A file that changed
 * since in a way the edit can't be undone on, or that is a link, is left as
 * it is and counted as skipped.
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const contentOf = (text: string) => text.replace(/\r\n/g, "\n");

interface Hunk {
  oldStart: number;
  /** The hunk's lines before (context and removed) and after (context and added). */
  before: string[];
  after: string[];
}

function hunksOf(diff: string): Hunk[] | undefined {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    const head = HUNK.exec(line);
    if (head) {
      current = { oldStart: Number(head[1]), before: [], after: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) current.after.push(line.slice(1));
    else if (line.startsWith("-")) current.before.push(line.slice(1));
    else if (line.startsWith(" ") || line === "") {
      current.before.push(line.slice(1));
      current.after.push(line.slice(1));
    }
  }
  return hunks.length ? hunks : undefined;
}

const sameAt = (lines: string[], at: number, want: string[]) =>
  at >= 0 &&
  at + want.length <= lines.length &&
  want.every((line, i) => lines[at + i] === line);

/** The text with an edit's hunks undone; undefined when they no longer match. */
export function reverseDiff(text: string, diff: string): string | undefined {
  const hunks = hunksOf(diff);
  if (!hunks) return undefined;
  const trailing = text.endsWith("\n");
  const lines = contentOf(text).split("\n");
  if (trailing) lines.pop();
  // Last hunk first, so earlier positions stay right.
  for (const hunk of [...hunks].reverse()) {
    const guess = Math.max(0, hunk.oldStart - 1);
    let at = -1;
    for (let d = 0; d <= lines.length; d++) {
      if (sameAt(lines, guess + d, hunk.after)) {
        at = guess + d;
        break;
      }
      if (d && sameAt(lines, guess - d, hunk.after)) {
        at = guess - d;
        break;
      }
      if (guess + d > lines.length && guess - d < 0) break;
    }
    if (at < 0) return undefined;
    lines.splice(at, hunk.after.length, ...hunk.before);
  }
  return lines.join("\n") + (trailing ? "\n" : "");
}

const isLink = (file: string) => {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

export function restoreFiles(
  changes: readonly RewindChange[],
  cwd: string,
): { restored: number; skipped: number } {
  let restored = 0;
  let skipped = 0;
  const abs = (file: string) => path.resolve(cwd, file);
  for (const change of [...changes].reverse()) {
    const file = abs(change.path);
    try {
      if (change.kind === "add") {
        if (!fs.existsSync(file)) continue;
        // Only the file as Claude wrote it is removed.
        if (
          isLink(file) ||
          contentOf(fs.readFileSync(file, "utf8")) !== contentOf(change.diff)
        ) {
          skipped++;
          continue;
        }
        fs.rmSync(file);
        restored++;
      } else if (change.kind === "delete") {
        if (fs.existsSync(file)) {
          skipped++;
          continue;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, change.diff);
        restored++;
      } else {
        const now = change.movePath ? abs(change.movePath) : file;
        if (!fs.existsSync(now) || isLink(now)) {
          skipped++;
          continue;
        }
        const back = reverseDiff(fs.readFileSync(now, "utf8"), change.diff);
        if (back === undefined) {
          skipped++;
          continue;
        }
        if (now !== file) {
          if (fs.existsSync(file)) {
            skipped++;
            continue;
          }
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, back);
          fs.rmSync(now);
        } else fs.writeFileSync(file, back);
        restored++;
      }
    } catch {
      skipped++;
    }
  }
  return { restored, skipped };
}
