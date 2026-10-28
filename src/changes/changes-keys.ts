/**
 * The Changes panel's keys and their models: toggleDiffFileList ⇧⌘Y in the
 * desktop app and Control+Shift+Y on the web; goToDiffFile ⌘P; nextDiffChange
 * F7 and, except on Linux, ⌥F5; prevDiffChange ⇧F7 and ⇧⌥F5. "cmd" reads Ctrl
 * outside macOS; "ctrl" is Control everywhere.
 */
export type ChangesKeyCommand =
  "file-list" | "go-to-file" | "next-change" | "previous-change";

export interface ChangesKeyPress {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

export interface ChangesKeyHost {
  /** macOS: "cmd" is Command. */
  mac: boolean;
  /** The desktop app (⇧⌘Y); the web uses Control+Shift+Y. */
  app: boolean;
  /** Linux leaves ⌥F5 to the system. */
  linux?: boolean;
}

export function changesKeyCommand(
  press: ChangesKeyPress,
  host: ChangesKeyHost,
): ChangesKeyCommand | undefined {
  if (press.isComposing) return undefined;
  const cmd = host.mac
    ? press.metaKey && !press.ctrlKey
    : press.ctrlKey && !press.metaKey;
  const control = press.ctrlKey && !press.metaKey;
  const letter = press.code?.startsWith("Key")
    ? press.code.slice(3).toLowerCase()
    : press.key.toLowerCase();
  if (
    letter === "y" &&
    press.shiftKey &&
    !press.altKey &&
    (host.app ? cmd : control)
  )
    return "file-list";
  if (letter === "p" && cmd && !press.shiftKey && !press.altKey)
    return "go-to-file";
  if (press.metaKey || press.ctrlKey) return undefined;
  const back = press.shiftKey;
  if (press.key === "F7" && !press.altKey)
    return back ? "previous-change" : "next-change";
  if (press.key === "F5" && press.altKey && !host.linux)
    return back ? "previous-change" : "next-change";
  return undefined;
}

/** A row of Go to file: a changed file and its counts. */
export interface GoToFileItem {
  path: string;
  additions: number;
  deletions: number;
}

/** Go to file lists at most this many rows (the original's 100). */
export const goToFileLimit = 100;

/**
 * The files Go to file shows for what was typed: every file when nothing
 * is, else those whose path holds the text, then those whose path holds
 * its letters in order (the original ranks with its file index), each
 * group in the panel's order. Case is ignored.
 */
export function goToFileMatches<T extends { path: string }>(
  files: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...files];
  const contained: T[] = [];
  const spread: T[] = [];
  for (const file of files) {
    const path = file.path.toLowerCase();
    if (path.includes(needle)) contained.push(file);
    else if (inOrder(path, needle.replace(/\s+/g, ""))) spread.push(file);
  }
  return [...contained, ...spread];
}

function inOrder(text: string, letters: string) {
  let at = 0;
  for (const letter of letters) {
    at = text.indexOf(letter, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/**
 * Next or previous change (the original's `ri`): the changes in reading
 * order, as the tops of their first lines; `last` is the one the previous
 * step landed on while it is still on screen. From it the step goes one
 * along; otherwise from the top of the view: next is the first change
 * below it, previous the last one above it. Nothing past either end.
 */
export function stepChange(
  tops: readonly number[],
  direction: 1 | -1,
  {
    last,
    viewTop,
  }: {
    last?: number;
    viewTop: number;
  },
): number | undefined {
  if (!tops.length) return undefined;
  if (last !== undefined && last >= 0 && last < tops.length) {
    const next = last + direction;
    return next >= 0 && next < tops.length ? next : undefined;
  }
  // A change whose top is within a pixel of the view's top is the one shown.
  if (direction === 1) {
    const index = tops.findIndex((top) => top > viewTop + 1);
    return index < 0 ? undefined : index;
  }
  for (let index = tops.length - 1; index >= 0; index--)
    if (tops[index] < viewTop - 1) return index;
  return undefined;
}
