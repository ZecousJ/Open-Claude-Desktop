import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionWorktree } from "../../shared/types";
import { gitEnvironment, safeGitConfig } from "./working-tree";

/**
 * A Code session's own worktree. The session runs in a new branch checked out
 * beside the folder's repository, so sessions in one folder keep their changes
 * apart. With no location set the worktrees live inside the repository under
 * .claude/worktrees (kept out of its status by .git/info/exclude); a location
 * puts them in <location>/<repository name>/. Archiving or deleting the session
 * removes a clean worktree and keeps one with changes; the branch always stays.
 */

/** Why a worktree could not be made, in the words the composer shows. */
export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly code: "no-git" | "not-repository" | "no-commits" | "failed",
  ) {
    super(message);
  }
}

const adjectives =
  "admiring adoring amazing awesome blissful bold brave busy charming clever cool dazzling determined dreamy eager elastic elegant epic festive focused friendly funny gallant gifted gracious happy hopeful inspiring jolly keen kind laughing lucid magical modest nifty nostalgic optimistic peaceful practical quirky relaxed serene sharp silly stoic sweet tender trusting upbeat vibrant wizardly youthful zealous".split(
    " ",
  );
const names =
  "agnesi archimedes babbage banach bardeen bell bohr booth bose cannon carson cerf clarke curie darwin dijkstra einstein euclid euler faraday fermat feynman franklin galileo gauss goodall hamilton hawking hopper hypatia johnson kepler knuth lamarr leakey lovelace mayer mccarthy meitner mirzakhani morse newton noether pascal pike ritchie shannon tesla thompson turing villani wiles wozniak".split(
    " ",
  );
const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];

/** A name like "brave-turing-3fa2c1" (the original's docker-style names). */
export function worktreeName() {
  return `${pick(adjectives)}-${pick(names)}-${randomBytes(3).toString("hex")}`;
}

/** The branch for a worktree: "<prefix>/<name>", or the bare name without a prefix. */
export function worktreeBranch(prefix: string, name: string) {
  const clean = prefix.trim().replace(/\/+$/, "");
  return clean ? `${clean}/${name}` : name;
}

export type Git = (
  cwd: string,
  args: string[],
  timeout?: number,
) => Promise<string>;

export const localGit: Git = (cwd, args, timeout = 30_000) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...safeGitConfig, ...args],
      {
        cwd,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...gitEnvironment },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout));
        const failure = error as NodeJS.ErrnoException & { stderr?: string };
        failure.stderr = String(stderr || "");
        reject(failure);
      },
    );
  });

const missingGit = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Keeps the in-repository worktrees out of the folder's own status. */
async function excludeWorktrees(git: Git, top: string) {
  try {
    const file = path.resolve(
      top,
      (await git(top, ["rev-parse", "--git-path", "info/exclude"])).trim(),
    );
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (/^\/?\.claude\/worktrees\/?$/m.test(text)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${text && !text.endsWith("\n") ? "\n" : ""}/.claude/worktrees/\n`,
    );
  } catch {}
}

export async function createSessionWorktree(
  folder: string,
  {
    location = "",
    prefix = "claude",
    startBranch,
    git = localGit,
  }: {
    location?: string;
    prefix?: string;
    /** A local branch to start from (the folder menu's Branch); HEAD otherwise. */
    startBranch?: string;
    git?: Git;
  } = {},
): Promise<{ worktree: SessionWorktree; cwd: string }> {
  let top: string;
  try {
    top = (await git(folder, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (missingGit(error))
      throw new WorktreeError("Git is required to use a worktree.", "no-git");
    throw new WorktreeError(
      "Start with worktree needs a Git repository.",
      "not-repository",
    );
  }
  top = path.resolve(top);
  try {
    await git(top, ["rev-parse", "--verify", "-q", "HEAD"]);
  } catch {
    throw new WorktreeError(
      "This repository has no commits yet, so a worktree can't start from it. Make a first commit, or turn off Worktree.",
      "no-commits",
    );
  }
  // Only an absolute folder counts as a location (Settings picks one).
  const custom = location.trim();
  const inside = !custom || !path.isAbsolute(custom);
  // A start branch that no longer exists falls back to HEAD.
  let start = "HEAD";
  if (startBranch && !startBranch.startsWith("-"))
    try {
      await git(top, [
        "rev-parse",
        "--verify",
        "-q",
        `refs/heads/${startBranch}`,
      ]);
      start = startBranch;
    } catch {}
  const parent = inside
    ? path.join(top, ".claude", "worktrees")
    : path.join(custom, path.basename(top));
  let name = worktreeName();
  while (fs.existsSync(path.join(parent, name))) name = worktreeName();
  const target = path.join(parent, name);
  const branch = worktreeBranch(prefix, name);
  if (inside) await excludeWorktrees(git, top);
  fs.mkdirSync(parent, { recursive: true });
  try {
    // Checking out a large repository can take minutes.
    await git(
      top,
      [
        "-c",
        "core.longpaths=true",
        "worktree",
        "add",
        "-b",
        branch,
        target,
        start,
      ],
      10 * 60_000,
    );
  } catch (error) {
    const detail = String(
      (error as { stderr?: string }).stderr || (error as Error).message || "",
    )
      .trim()
      .split("\n")
      .at(-1);
    console.warn("claudex: git worktree add failed:", detail);
    throw new WorktreeError(
      /No space left|ENOSPC/i.test(detail ?? "")
        ? "Free up disk space to set up a worktree, then try again."
        : "Couldn’t create a worktree in this repository.",
      "failed",
    );
  }
  // The session works in the same folder of the repository it was started in.
  const relative = path.relative(top, path.resolve(folder));
  const cwd =
    relative && !relative.startsWith("..")
      ? path.join(target, relative)
      : target;
  fs.mkdirSync(cwd, { recursive: true });
  return {
    worktree: {
      path: target,
      branch,
      repository: top,
      origin: path.resolve(folder),
      name,
    },
    cwd,
  };
}

/** How many files have changes in a worktree; null when git can't tell. */
export async function worktreeChanges(
  worktree: SessionWorktree,
  git: Git = localGit,
) {
  if (!fs.existsSync(worktree.path)) return 0;
  try {
    const status = await git(worktree.path, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ]);
    return status.split("\n").filter(Boolean).length;
  } catch {
    return null;
  }
}

/**
 * Removes a session's worktree once the session is archived or deleted:
 * "deleted" when it had no changes (the branch and its commits stay),
 * "kept" when it has changes or could not be checked.
 */
export async function removeSessionWorktree(
  worktree: SessionWorktree,
  git: Git = localGit,
): Promise<"deleted" | "kept"> {
  if (!fs.existsSync(worktree.path)) {
    await git(worktree.repository, ["worktree", "prune"]).catch(
      () => undefined,
    );
    return "deleted";
  }
  const changes = await worktreeChanges(worktree, git);
  if (changes !== 0) return "kept";
  try {
    await git(worktree.repository, [
      "-c",
      "core.longpaths=true",
      "worktree",
      "remove",
      worktree.path,
    ]);
    return "deleted";
  } catch {
    return "kept";
  }
}

/** Discards a kept worktree and its changes (the branch stays). */
export async function discardSessionWorktree(
  worktree: SessionWorktree,
  git: Git = localGit,
) {
  if (fs.existsSync(worktree.path))
    await git(worktree.repository, [
      "-c",
      "core.longpaths=true",
      "worktree",
      "remove",
      "--force",
      worktree.path,
    ]);
  await git(worktree.repository, ["worktree", "prune"]).catch(() => undefined);
}

/**
 * Brings back an archived session's worktree from its branch (unarchiving):
 * the folder is added again where it was, on the same branch.
 */
export async function restoreSessionWorktree(
  worktree: SessionWorktree,
  git: Git = localGit,
) {
  if (fs.existsSync(worktree.path)) return;
  await git(worktree.repository, ["worktree", "prune"]).catch(() => undefined);
  fs.mkdirSync(path.dirname(worktree.path), { recursive: true });
  await git(
    worktree.repository,
    [
      "-c",
      "core.longpaths=true",
      "worktree",
      "add",
      worktree.path,
      worktree.branch,
    ],
    10 * 60_000,
  );
}

/**
 * After the pull request merged (auto-archive): the worktree's branch goes too,
 * unless it holds commits that were never pushed. True when it was deleted.
 */
export async function deleteMergedBranch(
  worktree: SessionWorktree,
  git: Git = localGit,
) {
  try {
    const unpushed = (
      await git(worktree.repository, [
        "rev-list",
        "--count",
        `refs/heads/${worktree.branch}`,
        "--not",
        "--remotes",
      ])
    ).trim();
    if (unpushed !== "0") return false;
    await git(worktree.repository, ["branch", "-D", "--", worktree.branch]);
    return true;
  } catch {
    return false;
  }
}
