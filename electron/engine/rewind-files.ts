import fs from "node:fs";
import path from "node:path";
import { parseUnifiedDiff } from "../../shared/diff-model";
import type { RewindChange } from "../../shared/rewind-files";

/**
 * Undoes Claude's file edits for Rewind's "Code" restore, newest first: an
 * added file is removed, a deleted one written back, an edit's diff applied
 * in reverse (a moved file goes back to its old name). A file that changed
 * since in a way the edit can't be undone on, or that is a link, is left as
 * it is and counted as skipped.
 */

const contentOf = (text: string) => text.replace(/\r\n/g, "\n");

export function reverseDiff(text: string, diff: string): string | undefined {
  const files = parseUnifiedDiff(diff, "file");
  if (files.length !== 1 || !files[0].hunks.length) return undefined;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (const hunk of [...files[0].hunks].reverse()) {
    const before = hunk.lines
      .filter((line) => line.kind !== "add")
      .map((line) => line.text + (line.ending ?? "\n"));
    const after = hunk.lines
      .filter((line) => line.kind !== "del")
      .map((line) => line.text + (line.ending ?? "\n"));
    if (before.length !== hunk.oldLines || after.length !== hunk.newLines)
      return undefined;
    const guess = Math.max(0, hunk.newStart - (hunk.newLines ? 1 : 0));
    const matches = (at: number) =>
      at >= 0 &&
      at + after.length <= lines.length &&
      after.every((line, i) => lines[at + i] === line);
    let at = matches(guess) ? guess : -1;
    if (at < 0 && after.length) {
      const candidates = lines.flatMap((_, index) =>
        matches(index) ? [index] : [],
      );
      if (candidates.length === 1) at = candidates[0];
    }
    if (at < 0) return undefined;
    lines.splice(at, after.length, ...before);
  }
  return lines.join("");
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
