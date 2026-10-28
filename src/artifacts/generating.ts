import { itemIsRunning } from "../../shared/activity";
import type { Turn } from "../../shared/types";

const normalize = (value: string) => value.replace(/\\/g, "/");

/** A change path names the file: absolute paths must match, relative ones end it. */
function names(sourcePath: string, changePath: string) {
  const source = normalize(sourcePath);
  const change = normalize(changePath).replace(/^\.\//, "");
  if (/^(\/|[a-z]:\/)/i.test(change)) return source === change;
  return source === change || source.endsWith(`/${change}`);
}

/**
 * The live turn is still writing this file: one of its file changes that
 * names the path has started and not finished. Saved turns never count.
 */
export function rewritingFile(turns: Turn[], sourcePath: string) {
  const turn = turns.at(-1);
  if (turn?.status !== "inProgress") return false;
  return turn.items.some(
    (item) =>
      item.type === "fileChange" &&
      itemIsRunning(item) &&
      (item.changes ?? []).some((change) =>
        [change.path, change.kind?.move_path].some(
          (value) => typeof value === "string" && names(sourcePath, value),
        ),
      ),
  );
}
