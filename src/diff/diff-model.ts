/** Unified-diff parsing shared by the approval card, file rows and the Changes panel. */
export type DiffLineKind = "context" | "add" | "del";
export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the old file (context and deleted lines). */
  oldNo?: number;
  /** Line number in the new file (context and added lines). */
  newNo?: number;
  text: string;
  /** Character ranges that differ from the paired line, for word emphasis. */
  changed?: [number, number][];
}
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}
export type DiffStatus = "added" | "deleted" | "modified" | "renamed";
export interface DiffFile {
  path: string;
  oldPath?: string;
  status: DiffStatus;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  binary?: boolean;
  /** The executable bit changed: on ("Made executable") or off. */
  executable?: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(path: string) {
  const clean = path.replace(/\t.*$/, "").replace(/^"(.*)"$/, "$1");
  return clean === "/dev/null" ? clean : clean.replace(/^[ab]\//, "");
}

function count(file: DiffFile) {
  const lines = file.hunks.flatMap((hunk) => hunk.lines);
  file.additions = lines.filter((line) => line.kind === "add").length;
  file.deletions = lines.filter((line) => line.kind === "del").length;
  for (const hunk of file.hunks) markChangedRuns(hunk.lines);
  return file;
}

/** Parses `git diff` output (or bare hunks for one file) into files, hunks and numbered lines. */
export function parseUnifiedDiff(text: string, fallbackPath = ""): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0,
    newNo = 0,
    oldMode = "";
  const start = (path: string) => {
    oldMode = "";
    file = { path, status: "modified", hunks: [], additions: 0, deletions: 0 };
    files.push(file);
    hunk = undefined;
  };
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (git) {
      start(git[2]);
      if (git[1] !== git[2]) file!.oldPath = git[1];
      continue;
    }
    const header = HUNK.exec(raw);
    if (header) {
      if (!file) start(fallbackPath);
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      hunk = {
        oldStart: oldNo,
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: newNo,
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      file!.hunks.push(hunk);
      continue;
    }
    if (hunk && !hunkOpen(hunk, oldNo, newNo)) hunk = undefined;
    if (!hunk) {
      if (raw.startsWith("--- ") && (!file || file.hunks.length)) start("");
      if (!file) continue;
      if (raw.startsWith("new file mode")) file.status = "added";
      else if (raw.startsWith("deleted file mode")) file.status = "deleted";
      else if (raw.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = raw.slice(12);
      } else if (raw.startsWith("rename to ")) file.path = raw.slice(10);
      else if (raw.startsWith("Binary files ")) file.binary = true;
      else if (raw.startsWith("old mode ")) oldMode = raw.slice(9).trim();
      else if (raw.startsWith("new mode ")) {
        const to = raw.slice(9).trim();
        const exec = (mode: string) => (parseInt(mode, 8) & 0o111) !== 0;
        if (oldMode && exec(oldMode) !== exec(to)) file.executable = exec(to);
      } else if (raw.startsWith("--- ")) {
        const from = stripPrefix(raw.slice(4));
        if (from === "/dev/null") file.status = "added";
      } else if (raw.startsWith("+++ ")) {
        const to = stripPrefix(raw.slice(4));
        if (to === "/dev/null") file.status = "deleted";
        else if (!file.path) file.path = to;
      }
      continue;
    }
    const mark = raw[0];
    if (mark === "+")
      hunk.lines.push({ kind: "add", newNo: newNo++, text: raw.slice(1) });
    else if (mark === "-")
      hunk.lines.push({ kind: "del", oldNo: oldNo++, text: raw.slice(1) });
    else if (mark === " " || (raw === "" && blankContext(hunk, oldNo, newNo)))
      hunk.lines.push({
        kind: "context",
        oldNo: oldNo++,
        newNo: newNo++,
        text: raw.slice(1),
      });
  }
  return files.map(count);
}

/** Whether a hunk still expects lines, from the counts in its header. */
function hunkOpen(hunk: DiffHunk, oldNo: number, newNo: number) {
  return (
    oldNo < hunk.oldStart + hunk.oldLines ||
    newNo < hunk.newStart + hunk.newLines
  );
}
/** A blank line inside a hunk is a context line some tools emit without its leading space. */
function blankContext(hunk: DiffHunk, oldNo: number, newNo: number) {
  return (
    oldNo < hunk.oldStart + hunk.oldLines &&
    newNo < hunk.newStart + hunk.newLines
  );
}

function contentLines(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * One Codex file change as a diff. Codex sends the whole file for added and
 * deleted files and a unified diff for updates.
 */
export function fileChangeDiff(change: {
  path: string;
  kind?: unknown;
  diff?: string;
}): DiffFile {
  const kind =
    typeof change.kind === "string"
      ? change.kind
      : (change.kind as { type?: string } | undefined)?.type;
  const diff = change.diff ?? "";
  if ((kind === "add" || kind === "delete") && !HUNK.test(diff)) {
    const lines = contentLines(diff);
    const added = kind === "add";
    return count({
      path: change.path,
      status: added ? "added" : "deleted",
      hunks: [
        {
          oldStart: added ? 0 : 1,
          oldLines: added ? 0 : lines.length,
          newStart: added ? 1 : 0,
          newLines: added ? lines.length : 0,
          lines: lines.map((text, index) =>
            added
              ? { kind: "add", newNo: index + 1, text }
              : { kind: "del", oldNo: index + 1, text },
          ),
        },
      ],
      additions: 0,
      deletions: 0,
    });
  }
  const parsed = parseUnifiedDiff(diff, change.path)[0] ?? {
    path: change.path,
    status: "modified" as const,
    hunks: [],
    additions: 0,
    deletions: 0,
  };
  const moved = (change.kind as { move_path?: string | null } | undefined)
    ?.move_path;
  return {
    ...parsed,
    path: moved || change.path,
    ...(moved ? { oldPath: change.path, status: "renamed" as const } : {}),
    ...(kind === "add" ? { status: "added" as const } : {}),
    ...(kind === "delete" ? { status: "deleted" as const } : {}),
  };
}

export function diffTotals(files: DiffFile[]) {
  return files.reduce(
    (sum, file) => ({
      files: sum.files + 1,
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

const TOKEN = /\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g;

/** Character ranges of `a` whose tokens do not appear, in order, in `b` (token LCS). */
export function changedRanges(a: string, b: string): [number, number][] {
  const ta = [...a.matchAll(TOKEN)],
    tb = [...b.matchAll(TOKEN)];
  if (ta.length * tb.length > 40_000) return [];
  const table = Array.from({ length: ta.length + 1 }, () =>
    new Array<number>(tb.length + 1).fill(0),
  );
  for (let i = ta.length - 1; i >= 0; i--)
    for (let j = tb.length - 1; j >= 0; j--)
      table[i][j] =
        ta[i][0] === tb[j][0]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const ranges: [number, number][] = [];
  let i = 0,
    j = 0;
  const push = (token: RegExpMatchArray) => {
    const from = token.index!,
      to = from + token[0].length;
    const last = ranges.at(-1);
    if (last && last[1] === from) last[1] = to;
    else ranges.push([from, to]);
  };
  while (i < ta.length) {
    if (j < tb.length && ta[i][0] === tb[j][0]) {
      i++;
      j++;
    } else if (j < tb.length && table[i][j + 1] >= table[i + 1][j]) j++;
    else push(ta[i++]);
  }
  // Short unchanged gaps (a space, a bracket, a short name) join their neighbours,
  // so a rewritten expression reads as one change; indentation is never emphasised.
  const indent = /^\s*/.exec(a)![0].length;
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] - last[1] <= 4) last[1] = range[1];
    else merged.push([...range]);
  }
  return merged
    .map(([from, to]) => [Math.max(from, indent), to] as [number, number])
    .filter(([from, to]) => to > from);
}

/** Pairs each run of deleted lines with the added run after it and marks the words that changed. */
function markChangedRuns(lines: DiffLine[]) {
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind !== "del") {
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    while (lines[i]?.kind === "del") dels.push(lines[i++]);
    const adds: DiffLine[] = [];
    while (lines[i]?.kind === "add") adds.push(lines[i++]);
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      const del = dels[k],
        add = adds[k];
      const removed = changedRanges(del.text, add.text);
      const inserted = changedRanges(add.text, del.text);
      const size = (ranges: [number, number][]) =>
        ranges.reduce((sum, [from, to]) => sum + to - from, 0);
      // Lines that share nothing read better without emphasis.
      if (
        size(removed) < del.text.trim().length ||
        size(inserted) < add.text.trim().length
      ) {
        del.changed = removed;
        add.changed = inserted;
      }
    }
  }
}

/** The language highlight.js should use for a path, if any. */
export function languageForPath(path: string): string | undefined {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const ext = name.includes(".") ? name.split(".").at(-1)! : "";
  const map: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    mts: "typescript",
    cts: "typescript",
    tsx: "typescript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    ini: "ini",
    css: "css",
    scss: "scss",
    less: "less",
    html: "xml",
    htm: "xml",
    xml: "xml",
    svg: "xml",
    md: "markdown",
    sql: "sql",
    lua: "lua",
    r: "r",
  };
  return map[ext];
}

/**
 * Where unchanged lines are hidden around a file's hunks: before each hunk,
 * and after the last one when the file's current length is known.
 */
export function hiddenGaps(file: DiffFile, newLineCount?: number) {
  const before = file.hunks.map((hunk, index) => {
    if (index === 0) return hunk.newStart > 1 || hunk.oldStart > 1;
    const prev = file.hunks[index - 1];
    return hunk.newStart > prev.newStart + prev.newLines;
  });
  const last = file.hunks.at(-1);
  const after =
    last !== undefined &&
    newLineCount !== undefined &&
    file.status !== "deleted" &&
    last.newStart + last.newLines - 1 < newLineCount;
  return { before, after };
}

const blanks = (text: string) => text.replace(/\s+/g, "");

/**
 * A run of deleted lines against the added run after it, with the lines that
 * only differ in whitespace paired as unchanged context (the longest
 * matching sequence, as `git diff -w` does); the rest stay deleted or added.
 */
function pairByContent(dels: DiffLine[], adds: DiffLine[]): DiffLine[] {
  if (dels.length * adds.length > 40_000) return [...dels, ...adds];
  const a = dels.map((line) => blanks(line.text));
  const b = adds.map((line) => blanks(line.text));
  const table = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  if (!table[0][0]) return [...dels, ...adds];
  const out: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({
        kind: "context",
        oldNo: dels[i].oldNo,
        newNo: adds[j].newNo,
        text: adds[j].text,
      });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j === b.length || table[i + 1][j] >= table[i][j + 1])
    )
      out.push(dels[i++]);
    else out.push(adds[j++]);
  }
  return out;
}

/**
 * The file as `git diff -w` would show it ("Hide whitespace changes"): lines
 * that differ only in whitespace become unchanged context, hunks with no
 * change left drop out, and so does a modified file nothing else changed in.
 */
export function hideWhitespaceChanges(file: DiffFile): DiffFile | undefined {
  if (file.binary || !file.hunks.length) return file;
  const hunks: DiffHunk[] = [];
  for (const hunk of file.hunks) {
    const lines: DiffLine[] = [];
    for (let i = 0; i < hunk.lines.length;) {
      if (hunk.lines[i].kind === "context") {
        lines.push(hunk.lines[i++]);
        continue;
      }
      const dels: DiffLine[] = [];
      while (hunk.lines[i]?.kind === "del") dels.push(hunk.lines[i++]);
      const adds: DiffLine[] = [];
      while (hunk.lines[i]?.kind === "add") adds.push(hunk.lines[i++]);
      lines.push(
        ...pairByContent(
          dels.map(({ changed: _, ...line }) => line),
          adds.map(({ changed: _, ...line }) => line),
        ),
      );
    }
    if (lines.some((line) => line.kind !== "context"))
      hunks.push({ ...hunk, lines });
  }
  if (!hunks.length && file.status === "modified") return undefined;
  return count({ ...file, hunks });
}

/** One row of the side-by-side layout: the old line on the left, the new on the right. */
export interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

/**
 * Pairs a hunk's lines for Side by side: a context line shows on both sides;
 * within a change, the removed lines pair with the added ones in order, and the
 * longer run leaves the other side empty.
 */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      index++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === "del")
      removed.push(lines[index++]);
    while (index < lines.length && lines[index].kind === "add")
      added.push(lines[index++]);
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      rows.push({ left: removed[i], right: added[i] });
  }
  return rows;
}

/**
 * Whether a file's changes only move whitespace (the original's "Whitespace
 * only" badge): every changed line, with all whitespace taken out, matches
 * one on the other side.
 */
export function whitespaceOnly(file: DiffFile) {
  let changed = false;
  for (const hunk of file.hunks) {
    const removed: string[] = [];
    const added: string[] = [];
    for (const line of hunk.lines) {
      if (line.kind === "del") removed.push(line.text.replace(/\s+/g, ""));
      else if (line.kind === "add") added.push(line.text.replace(/\s+/g, ""));
    }
    if (removed.length || added.length) changed = true;
    if (removed.filter(Boolean).join("\n") !== added.filter(Boolean).join("\n"))
      return false;
  }
  return changed;
}
