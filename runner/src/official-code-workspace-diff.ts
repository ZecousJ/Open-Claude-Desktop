import fs from "node:fs/promises";
import path from "node:path";
import {
  parseDiffNameStatus,
  parseDiffNumstat,
  parseGitPatches,
} from "../../electron/git/git-diff-metadata";
import { workingTreeBase } from "../../electron/git/git-scope";
import {
  emptyGitTree,
  type WorkingTreeHost,
} from "../../electron/git/working-tree";
import type { DiffFile } from "../../shared/diff-model";
import { officialCodeWorkspaceDiffMaxChars } from "../../shared/official-code-followup";
import type { Conversation } from "../../shared/types";
import { codeWorkspaceRoot, inCodeWorkspace } from "./code-workspace";
import { within } from "./sandbox/driver";
import type { WebAppContext } from "./web-app-context";

type FileStats = ReturnType<typeof parseDiffNameStatus>[number] & {
  added: number;
  removed: number;
  isBinary: boolean;
  isUntracked: boolean;
};
type Hunk = Omit<DiffFile["hunks"][number], "lines"> & { lines: string[] };
type Source =
  | { kind: "working-tree" }
  | { kind: "branch"; baseBranch: string; baseRef: string };
type WorkspaceDiff = {
  stats: { filesCount: number; linesAdded: number; linesRemoved: number };
  perFileStats: FileStats[];
  hunks: { path: string; hunks: Hunk[] }[];
  skippedLarge: string[];
  restricted: string[];
  source: Source;
};

const maxFiles = 1000;
const maxFileLines = 800;
const maxLines = 40_000;
const diffArgs = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--find-renames",
  "--no-relative",
];
const patchArgs = [
  "--patch",
  "-U3",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--output-indicator-context= ",
  "--output-indicator-new=+",
  "--output-indicator-old=-",
];
const emptyStats = { added: 0, removed: 0, isBinary: false };
const prefix = { add: "+", del: "-", context: " " };
const overflow = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

const spaceHosts = new WeakMap<
  WebAppContext,
  { profile: string; hosts: Map<string, WorkingTreeHost> }
>();

function workspaceHost(ctx: WebAppContext, root: string, spaceId?: string) {
  if (!spaceId) return ctx.services?.workingTree;
  let entry = spaceHosts.get(ctx);
  if (!entry || entry.profile !== ctx.store.root) {
    entry = { profile: ctx.store.root, hosts: new Map() };
    spaceHosts.set(ctx, entry);
  }
  const existing = entry.hosts.get(spaceId);
  if (existing) return existing;
  const host = ctx.runtime?.workingTree?.({
    userId: ctx.userId,
    storeRoot: root,
    spaceId,
  });
  if (host) entry.hosts.set(spaceId, host);
  return host;
}

export async function readOfficialCodeWorkspaceDiff(
  ctx: WebAppContext,
  conversation: Conversation,
): Promise<WorkspaceDiff | null | undefined> {
  const { cwd, environment } = conversation;
  if (!cwd) return null;
  const spaceId =
    environment?.kind === "space" ? environment.spaceId : undefined;
  const root = spaceId ? ctx.spaceRoot(spaceId) : ctx.store.root;
  const workspace = path.join(root, "workspace");
  if (!path.isAbsolute(cwd) || !inCodeWorkspace(workspace, cwd)) return null;
  const codeRoot = codeWorkspaceRoot(workspace);
  const sessionRoot = path.join(
    codeRoot,
    path.relative(codeRoot, cwd).split(path.sep)[0],
  );
  const realRoot = await fs.realpath(root);
  if (
    (await fs.realpath(cwd)) !== path.join(realRoot, path.relative(root, cwd))
  )
    return null;
  const host = workspaceHost(ctx, root, spaceId);
  if (!host) throw Error("The Code workspace reader is unavailable.");
  const { git } = host;
  const top = (
    await git(cwd, ["rev-parse", "--show-toplevel"], [0, 128])
  ).trim();
  if (
    !top ||
    !within(top, path.join(realRoot, path.relative(root, sessionRoot)))
  )
    return null;

  const { head, named, baseName, baseRef, mergeBase } = await workingTreeBase(
    git,
    top,
  );
  const against = mergeBase || head || emptyGitTree;
  const source: Source =
    baseName &&
    baseRef &&
    mergeBase &&
    (named !== baseName || mergeBase !== head)
      ? { kind: "branch", baseBranch: baseName, baseRef: mergeBase }
      : { kind: "working-tree" };
  const tracked = parseDiffNameStatus(
    await git(top, [...diffArgs, "--name-status", "-z", against, "--"]),
  );
  const trackedPaths = new Set(tracked.map((file) => file.path));
  const untracked = (
    await git(top, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter((name) => name && !trackedPaths.has(name));
  if (tracked.length + untracked.length > maxFiles) return undefined;
  if ([...trackedPaths, ...untracked].some((name) => name.includes("\n")))
    return undefined;
  const names = [
    ...tracked.flatMap(({ path, status, previousPath }) => [
      path,
      path,
      status,
      previousPath ?? "",
    ]),
    ...untracked.flatMap((path) => [path, path, "added"]),
    ...(source.kind === "branch" ? [source.baseBranch, source.baseRef] : []),
  ];
  if (names.some((name) => name.length > 4096)) return undefined;
  let chars =
    officialCodeWorkspaceDiffMaxChars -
    names.reduce((n, name) => n + name.length + 1, 0);
  if (chars < 0) return undefined;
  let lines = 0;
  const hunks: WorkspaceDiff["hunks"] = [];
  const skippedLarge: string[] = [];
  const restricted: string[] = [];

  function addHunks(file: DiffFile) {
    if (!file.hunks.length) return;
    const rows = file.hunks.map(({ lines, ...span }) => ({
      ...span,
      lines: lines.flatMap(({ kind, text, ending }) => {
        const line = prefix[kind] + text + (ending === "\r\n" ? "\r" : "");
        return ending === "" ? [line, "\\ No newline at end of file"] : [line];
      }),
    }));
    const fileLines = rows.reduce((n, row) => n + row.lines.length, 0);
    const cost = rows.reduce(
      (n, row) =>
        n + 40 + row.lines.reduce((m, line) => m + line.length + 1, 0),
      0,
    );
    if (
      fileLines > maxFileLines ||
      lines + fileLines > maxLines ||
      cost > chars
    ) {
      skippedLarge.push(file.path);
      return;
    }
    lines += fileLines;
    chars -= cost;
    hunks.push({ path: file.path, hunks: rows });
  }

  const stats = parseDiffNumstat(
    await git(top, [...diffArgs, "--numstat", "-z", against, "--"]),
  );
  const perFileStats: FileStats[] = tracked.map((file) => ({
    ...file,
    ...(stats.get(file.path) ?? emptyStats),
    isUntracked: false,
  }));
  async function readTrackedPatches(files: FileStats[]) {
    if (!files.length) return;
    const paths = [
      ...new Set(
        files.flatMap(({ path, previousPath }) =>
          previousPath ? [path, previousPath] : [path],
        ),
      ),
    ];
    let patch: string;
    try {
      patch = await git(top, [
        ...diffArgs,
        ...patchArgs,
        against,
        "--",
        ...paths.map((name) => `:(literal)${name}`),
      ]);
    } catch (error) {
      if (!overflow(error)) throw error;
      if (files.length === 1) skippedLarge.push(files[0].path);
      else {
        const midpoint = Math.floor(files.length / 2);
        await readTrackedPatches(files.slice(0, midpoint));
        await readTrackedPatches(files.slice(midpoint));
      }
      return;
    }
    for (const { file } of parseGitPatches(patch)) addHunks(file);
  }
  const inline: FileStats[] = [];
  for (const file of perFileStats) {
    const changed = file.added + file.removed;
    if (changed > maxFileLines) skippedLarge.push(file.path);
    else if (changed) inline.push(file);
  }
  await readTrackedPatches(inline);

  const entries = await host.entries(top, untracked);
  for (const name of untracked) {
    const args = ["--no-index", "--", "/dev/null", name];
    let result: string;
    if (!entries.has(name)) {
      restricted.push(name);
      result = "";
    } else {
      try {
        result = await git(
          top,
          [...diffArgs, "--numstat", "-z", ...patchArgs, ...args],
          [0, 1],
        );
      } catch (error) {
        if (!overflow(error)) throw error;
        skippedLarge.push(name);
        result = await git(
          top,
          [...diffArgs, "--numstat", "-z", ...args],
          [0, 1],
        );
      }
    }
    const separator = result.indexOf("\0diff --git ");
    const numstat = separator === -1 ? result : result.slice(0, separator);
    perFileStats.push({
      path: name,
      status: "added",
      ...(parseDiffNumstat(numstat).get(name) ?? emptyStats),
      isUntracked: true,
    });
    if (separator !== -1)
      for (const { file } of parseGitPatches(result.slice(separator + 1)))
        addHunks(file);
  }
  return {
    stats: {
      filesCount: perFileStats.length,
      linesAdded: perFileStats.reduce((n, file) => n + file.added, 0),
      linesRemoved: perFileStats.reduce((n, file) => n + file.removed, 0),
    },
    perFileStats,
    hunks,
    skippedLarge,
    restricted,
    source,
  };
}
