import type { Turn } from "./types";

/**
 * Rewind with code restore. The code is the file edits Claude made from the
 * message on, undone newest first (electron/rewind-files.ts).
 */

export type RewindScope = "both" | "conversation" | "code";

/** One file edit Claude made (a Codex fileChange's change). */
export interface RewindChange {
  path: string;
  kind: "add" | "delete" | "update";
  /** The whole file for add and delete, a unified diff for update. */
  diff: string;
  /** Where an update moved the file. */
  movePath?: string;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

/** The applied file edits of these turns, oldest first. */
export function rewindChanges(turns: readonly Turn[]): RewindChange[] {
  const out: RewindChange[] = [];
  for (const turn of turns)
    for (const item of turn.items) {
      if (item.type !== "fileChange") continue;
      if (item.status !== "completed" && item.lifecycleStatus !== "completed")
        continue;
      for (const change of item.changes ?? []) {
        const raw = change.kind as unknown;
        const type =
          typeof raw === "string" ? raw : (raw as { type?: string })?.type;
        if (type !== "add" && type !== "delete" && type !== "update") continue;
        const movePath =
          (raw as { move_path?: string | null })?.move_path ?? undefined;
        out.push({
          path: change.path,
          kind: type,
          diff: change.diff ?? "",
          ...(movePath ? { movePath } : {}),
        });
      }
    }
  return out;
}

const contentLines = (text: string) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** What a code restore undoes: the files, and the lines the edits added and removed. */
export function rewindPreview(changes: readonly RewindChange[]) {
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  for (const change of changes) {
    files.add(change.movePath ?? change.path);
    if (change.kind !== "update" && !HUNK.test(change.diff)) {
      const count = contentLines(change.diff).length;
      if (change.kind === "add") insertions += count;
      else deletions += count;
      continue;
    }
    for (const line of change.diff.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) insertions++;
      else if (line.startsWith("-")) deletions++;
    }
  }
  return { filesChanged: [...files], insertions, deletions };
}
