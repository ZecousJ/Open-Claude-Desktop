import { execFile } from "node:child_process";
import { gitEnvironment, safeGitConfig } from "./working-tree";
import { validBranchName } from "./git-scope";
import type {
  FolderBranches,
  FolderChanges,
  FolderChangesAction,
  FolderSwitchResult,
} from "../../shared/code-usage-api";

/**
 * The new task's folder and its branch. Without Worktree, choosing a branch
 * checks it out in the folder; uncommitted changes are first stashed, committed
 * as WIP or discarded, as the person picks in the "Uncommitted changes" dialog.
 */
type Git = (cwd: string, args: string[]) => Promise<string>;

const localGit: Git = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...safeGitConfig, "-c", "core.hooksPath=", ...args],
      {
        cwd,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...gitEnvironment },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout));
        (error as { stderr?: string }).stderr = String(stderr || "");
        reject(error);
      },
    );
  });

/** The repository's local branches, most recently committed first. */
export async function folderBranches(
  folder: string,
  git: Git = localGit,
): Promise<FolderBranches | null> {
  try {
    await git(folder, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
  const current =
    (
      await git(folder, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(
        () => "",
      )
    ).trim() || null;
  const branches = (
    await git(folder, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      "refs/heads",
    ]).catch(() => "")
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // The default branch: origin's HEAD, else main or master.
  const remoteHead = (
    await git(folder, [
      "symbolic-ref",
      "--short",
      "-q",
      "refs/remotes/origin/HEAD",
    ]).catch(() => "")
  ).trim();
  const fromRemote = remoteHead.startsWith("origin/")
    ? remoteHead.slice(7)
    : "";
  const defaultBranch =
    (fromRemote && branches.includes(fromRemote) ? fromRemote : "") ||
    ["main", "master"].find((name) => branches.includes(name)) ||
    null;
  return { current, branches, defaultBranch };
}

/** How many files have uncommitted changes, and their line counts. */
export async function folderChanges(
  folder: string,
  git: Git = localGit,
): Promise<FolderChanges | null> {
  let status: string;
  try {
    status = await git(folder, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ]);
  } catch {
    return null;
  }
  const files = status.split("\n").filter(Boolean).length;
  let additions = 0,
    deletions = 0;
  const numstat = await git(folder, ["diff", "HEAD", "--numstat"]).catch(
    () => "",
  );
  for (const line of numstat.split("\n")) {
    const [added, removed] = line.split("\t");
    if (/^\d+$/.test(added ?? "")) additions += Number(added);
    if (/^\d+$/.test(removed ?? "")) deletions += Number(removed);
  }
  return { files, additions, deletions };
}

export function branchPathsOverlap(changes: string[], target: string[]) {
  return changes.some((raw) => {
    const changed = raw.replace(/\/$/, "");
    return target.some(
      (file) =>
        file === changed ||
        file.startsWith(`${changed}/`) ||
        changed.startsWith(`${file}/`),
    );
  });
}

// .
export async function checkBranchSwitchConflict(
  folder: string,
  branch: string,
  git: Git = localGit,
) {
  if (!validBranchName(branch)) return true;
  try {
    const status = await git(folder, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
    ]);
    if (!status) return false;
    const entries = status.split("\0");
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (!entry) continue;
      const code = entry.slice(0, 2);
      if (code.includes("U") || code === "AA" || code === "DD") return true;
      paths.push(entry.slice(3));
      if (/[RC]/.test(code)) {
        const original = entries[++index];
        if (!original) return true;
        paths.push(original);
      }
    }
    let target = "";
    for (const ref of [
      `refs/heads/${branch}`,
      `refs/remotes/origin/${branch}`,
    ]) {
      target = (
        await git(folder, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${ref}^{commit}`,
        ]).catch(() => "")
      ).trim();
      if (target) break;
    }
    if (!/^[a-f0-9]{40,64}$/.test(target)) return true;
    const changed = await git(folder, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "--no-renames",
      "-z",
      "HEAD",
      target,
      "--",
    ]);
    return branchPathsOverlap(paths, changed.split("\0").filter(Boolean));
  } catch {
    return true;
  }
}

/** Checks out `branch`; refused with "dirty" when the switch would overwrite changes. */
export async function switchFolderBranch(
  folder: string,
  branch: string,
  git: Git = localGit,
): Promise<FolderSwitchResult> {
  const known = await folderBranches(folder, git);
  if (!known || !known.branches.includes(branch))
    return { ok: false, reason: "failed" };
  if (known.current === branch) return { ok: true };
  if (await checkBranchSwitchConflict(folder, branch, git))
    return { ok: false, reason: "dirty" };
  try {
    await git(folder, ["checkout", "--quiet", branch, "--"]);
    return { ok: true };
  } catch (error) {
    // The branch is checked out in another worktree.
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    if (/already (?:checked out|used by worktree)/i.test(stderr))
      return { ok: false, reason: "elsewhere" };
    if (
      /would be overwritten|would be lost|resolve your current index/i.test(
        stderr,
      )
    )
      return { ok: false, reason: "dirty" };
    return { ok: false, reason: "failed" };
  }
}

/**
 * Clears the folder's uncommitted changes before a branch switch: stash
 * (untracked files too), a "WIP" commit on the current branch, or discard
 * (reset to HEAD and remove untracked files; ignored files stay).
 */
export async function resolveFolderChanges(
  folder: string,
  action: FolderChangesAction,
  git: Git = localGit,
): Promise<boolean> {
  try {
    const branch =
      (
        await git(folder, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(
          () => "",
        )
      ).trim() || "HEAD";
    if (action === "stash")
      await git(folder, [
        "stash",
        "push",
        "--include-untracked",
        "-m",
        `claudex: pre-switch from ${branch}`,
      ]);
    else if (action === "commit") {
      await git(folder, ["add", "-A"]);
      await git(folder, ["commit", "--quiet", "--no-verify", "-m", "WIP"]);
    } else {
      await git(folder, ["reset", "--hard", "--quiet", "HEAD"]);
      await git(folder, ["clean", "-fd", "--quiet"]);
    }
    return true;
  } catch {
    return false;
  }
}
