import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { DiffScope, WorkingTreeChanges } from "../../shared/types";
import {
  ask,
  branchCommits,
  defaultBaseBranch,
  mainRemote,
  resolveBase,
  validBranchName,
  validCommitId,
} from "./git-scope";

/**
 * Read-only `git` queries behind the Changes panel. The folder is one the agent
 * writes to, so repository config must not run programs here: no fsmonitor
 * hook, external diff or textconv driver.
 *
 * The queries run where the folder is: on this computer (`localWorkingTree`) or
 * on an SSH host (`RemoteWorkspace` in electron/ssh/remote-workspace.ts, R9),
 * which implements the same `WorkingTreeHost`.
 */
const MAX_DIFF = 2_000_000;
const MAX_UNTRACKED = 50;
const MAX_UNTRACKED_BYTES = 512_000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Runs one read-only `git` query in `cwd` and resolves with its output when
 * the exit code is in `okCodes` (default: 0 only).
 */
export type GitRunner = (
  cwd: string,
  args: string[],
  okCodes?: number[],
) => Promise<string>;

/** The `-c` settings every query starts with (no hooks, colours or quoting). */
export const safeGitConfig = [
  "-c",
  "core.quotepath=off",
  "-c",
  "color.ui=false",
  "-c",
  "core.fsmonitor=false",
];
/** The environment every query runs with (no optional index locks). */
export const gitEnvironment = { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };

/** A file of the working tree as `lstat` sees it (links are never followed). */
export interface TreeEntry {
  kind: "file" | "symlink";
  size: number;
}

/**
 * Where the Changes panel's folder is. File paths are relative to the
 * repository's top folder.
 */
export interface WorkingTreeHost {
  git: GitRunner;
  /** The regular files and links among `files`; anything else is left out. */
  entries(top: string, files: string[]): Promise<Map<string, TreeEntry>>;
  /** Line counts of the regular files among `files` up to `maxBytes` each. */
  lineCounts(
    top: string,
    files: string[],
    maxBytes: number,
  ): Promise<Record<string, number>>;
}

/**
 * Whether an error is the host's own (an SSH host that can't be reached)
 * rather than a `git` query that failed: it reaches the panel instead of
 * reading as "not a Git repository".
 */
export function isTransportError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as { transport?: unknown }).transport,
  );
}

const localGit: GitRunner = (cwd, args, okCodes = [0]) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      [...safeGitConfig, ...args],
      {
        cwd,
        timeout: 30_000,
        maxBuffer: 16 * MAX_DIFF,
        windowsHide: true,
        env: { ...process.env, ...gitEnvironment },
      },
      (error, stdout) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? -1
              : 0;
        if (okCodes.includes(code)) resolve(stdout);
        else reject(error);
      },
    );
  });

async function lineCount(file: string, maxBytes: number) {
  try {
    // lstat: a symlink's diff is its target path, never the file it points at.
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    const text = await fs.readFile(file, "utf8");
    if (!text) return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return undefined;
  }
}

/** This computer's working trees. */
export const localWorkingTree: WorkingTreeHost = {
  git: localGit,
  async entries(top, files) {
    const found = new Map<string, TreeEntry>();
    for (const file of files) {
      const stat = await fs.lstat(path.join(top, file)).catch(() => undefined);
      if (stat?.isFile()) found.set(file, { kind: "file", size: stat.size });
      else if (stat?.isSymbolicLink())
        found.set(file, { kind: "symlink", size: stat.size });
    }
    return found;
  },
  async lineCounts(top, files, maxBytes) {
    const counts: Record<string, number> = {};
    for (const file of files) {
      const count = await lineCount(path.join(top, file), maxBytes);
      if (count !== undefined) counts[file] = count;
    }
    return counts;
  },
};

/** Paths a unified diff touches on its new side. */
export function diffPaths(diff: string) {
  return [
    ...new Set(
      [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) =>
        match[1].replace(/\t.*$/, ""),
      ),
    ),
  ];
}

/** An empty answer for a query that failed, unless the host itself failed. */
function orEmpty(error: unknown): string {
  if (isTransportError(error)) throw error;
  return "";
}

/**
 * The folder's changes in the scope the panel asks for:
 * - "branch" (All changes): the working tree, untracked files included,
 *   against the point where the branch left its base (`scope.base`, else
 *   the repository's default branch, on the remote when it has one);
 * - "uncommitted": the working tree against HEAD;
 * - "commit": what one commit changed against its parent.
 * Every scope also says whether the working tree is dirty and lists the
 * branch's own commits, so the panel can offer the others.
 */
export async function workingTreeChanges(
  cwd: string | undefined,
  context = 3,
  host: WorkingTreeHost = localWorkingTree,
  scope: DiffScope = { kind: "branch" },
): Promise<WorkingTreeChanges> {
  const empty = { diff: "", lineCounts: {} };
  if (!cwd) return { state: "no-folder", ...empty };
  const git = host.git;
  let top: string;
  try {
    top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (isTransportError(error)) throw error;
    return { state: "not-git", ...empty };
  }
  const unit = `-U${Math.max(0, Math.min(10_000, Math.floor(context)))}`;
  const head = await git(top, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1])
    .then((out) => out.trim())
    .catch(orEmpty);
  const branch = head
    ? (await git(top, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
    : (
        await git(top, ["symbolic-ref", "--short", "HEAD"]).catch(orEmpty)
      ).trim();
  const named = branch && branch !== "HEAD" ? branch : undefined;
  const remote = await mainRemote(git, top);
  const defaultBase = await defaultBaseBranch(git, top, remote, named);
  const baseName = validBranchName(scope.base) ? scope.base : defaultBase;
  const baseRef = head
    ? await resolveBase(git, top, remote, baseName)
    : undefined;
  // Where the branch left its base; none when they share no commit.
  const mergeBase = baseRef
    ? await ask(git, top, ["merge-base", baseRef, "HEAD"])
    : head;
  const baseUnknown = Boolean(baseRef && !mergeBase);
  const commits =
    baseRef && mergeBase ? await branchCommits(git, top, baseRef) : [];
  const dirty = Boolean(
    await git(top, ["status", "--porcelain", "--untracked-files=normal"])
      .then((out) => out.trim())
      .catch(orEmpty),
  );
  const facts = {
    defaultBase,
    ...(named ? { branch: named } : {}),
    dirty,
    ...(baseUnknown ? { baseUnknown } : {}),
    commits,
  };

  // One commit: its own changes, nothing from the working tree.
  if (scope.kind === "commit" && validCommitId(scope.sha) && head) {
    const sha = await ask(git, top, [
      "rev-parse",
      "--verify",
      "-q",
      `${scope.sha}^{commit}`,
    ]);
    if (sha) {
      const parent =
        (await ask(git, top, ["rev-parse", "--verify", "-q", `${sha}^`])) ||
        EMPTY_TREE;
      let diff = await git(top, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        unit,
        parent,
        sha,
        "--",
      ]);
      let truncated = false;
      if (diff.length > MAX_DIFF) {
        diff = diff.slice(0, diff.lastIndexOf("\ndiff --git ", MAX_DIFF) + 1);
        truncated = true;
      }
      return {
        state: "ready",
        scope: "commit",
        base: baseName,
        head: sha.slice(0, 7),
        diff,
        lineCounts: {},
        ...(truncated ? { truncated } : {}),
        ...facts,
      };
    }
  }

  const uncommitted = scope.kind === "uncommitted";
  const against = uncommitted || baseUnknown || !mergeBase ? head : mergeBase;
  let diff = await git(top, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    unit,
    against || EMPTY_TREE,
    "--",
  ]);
  const untracked = (
    await git(top, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean);
  let truncated = untracked.length > MAX_UNTRACKED;
  const listed = untracked.slice(0, MAX_UNTRACKED);
  const entries = listed.length
    ? await host.entries(top, listed)
    : new Map<string, TreeEntry>();
  for (const file of listed) {
    if (diff.length > MAX_DIFF) break;
    const stat = entries.get(file);
    if (!stat || stat.size > MAX_UNTRACKED_BYTES) {
      truncated = true;
      continue;
    }
    diff += await git(
      top,
      [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        unit,
        "--",
        "/dev/null",
        file,
      ],
      [0, 1],
    );
  }
  if (diff.length > MAX_DIFF) {
    diff = diff.slice(0, diff.lastIndexOf("\ndiff --git ", MAX_DIFF) + 1);
    truncated = true;
  }
  const paths = diffPaths(diff);
  const lineCounts = paths.length
    ? await host.lineCounts(top, paths, MAX_DIFF)
    : {};
  // The label: the base branch, or what HEAD is when the diff starts there.
  const fromHead = named ?? (head.slice(0, 7) || undefined);
  return {
    state: "ready",
    scope: uncommitted ? "uncommitted" : "branch",
    base: uncommitted || !baseRef ? fromHead : baseName,
    diff,
    lineCounts,
    ...(truncated ? { truncated } : {}),
    ...facts,
  };
}
