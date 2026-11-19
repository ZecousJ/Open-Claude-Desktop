import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitEnvironment, localWorkingTree, safeGitConfig } from "./working-tree";
import type {
  FolderBranches,
  FolderChanges,
  FolderChangesAction,
  FolderSwitchResult,
} from "../../shared/code-usage-api";

/**
 * The new task's folder and its branch (live claude.ai bundle, 2026-10-14:
 * the folder menu's Branch submenu). Without Worktree, choosing a branch
 * checks it out in the folder; uncommitted changes are first stashed,
 * committed as WIP or discarded, as the person picks in the "Uncommitted
 * changes" dialog.
 */
type Git = (cwd: string, args: string[]) => Promise<string>;

const execGit = promisify(execFile);
const localGit: Git = async (cwd, args) =>
  (await execGit("git", [...safeGitConfig, "-c", "core.hooksPath=", ...args], {
    cwd,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, ...gitEnvironment },
  })).stdout;

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
      await git(folder, ["symbolic-ref", "-q", "HEAD"]).catch(
        () => "",
      )
    ).trim().replace(/^refs\/heads\//, "") || null;
  const branches = (
    await git(folder, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:lstrip=2)",
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
  const paths = new Set(target);
  const parents = new Set<string>();
  for (const file of target)
    for (let end = file.indexOf("/"); end !== -1; end = file.indexOf("/", end + 1))
      parents.add(file.slice(0, end));
  return changes.some((raw) => {
    const changed = raw.replace(/\/$/, "");
    if (paths.has(changed) || parents.has(changed)) return true;
    for (let end = changed.indexOf("/"); end !== -1; end = changed.indexOf("/", end + 1))
      if (paths.has(changed.slice(0, end))) return true;
    return false;
  });
}

// (live desktop 2.37337.1, index.chunk-D9jr5E25.js, wouldBranchSwitchConflict).
export async function checkBranchSwitchConflict(
  folder: string,
  branch: string,
  git: Git = localGit,
) {
  if (branch.startsWith("-")) return true;
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
  } catch (error) {
    return !/not a git repository/i.test(gitError(error));
  }
}

function gitError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  if ("stderr" in error && typeof error.stderr === "string" && error.stderr.trim())
    return error.stderr.trim();
  return error.message.trim();
}

export async function isBranchOnOrigin(folder: string, branch: string) {
  const git = localWorkingTree.git;
  try {
    if ((await git(folder, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`], [0, 1])).trim())
      return true;
    const fetch = (await git(folder, ["config", "--no-includes", "--get-all", "remote.origin.fetch"], [0, 1]))
      .trim().split("\n").map(ref => ref.replace(/^\+/, "")).filter(Boolean);
    if (fetch.some(ref => ref.startsWith("^"))) return null;
    if (fetch.includes("refs/heads/*:refs/remotes/origin/*")) return false;
    const tracked = fetch.filter(ref => ref.startsWith("refs/heads/")).map(ref => {
      const [source, destination] = ref.split(":");
      const pattern = source.slice("refs/heads/".length);
      return destination === `refs/remotes/origin/${pattern}` ? pattern : "";
    });
    if (tracked.some(pattern => !pattern)) return null;
    return tracked.some(pattern => {
      const wildcard = pattern.indexOf("*");
      return wildcard < 0 ? pattern === branch :
        branch.length >= pattern.length - 1 &&
        branch.startsWith(pattern.slice(0, wildcard)) &&
        branch.endsWith(pattern.slice(wildcard + 1));
    }) ? false : null;
  } catch {
    return null;
  }
}

type FolderBranchAction =
  | { kind: "stash"; message: string }
  | { kind: "commit"; fromBranch: string }
  | { kind: "discard" };

type FolderBranchActionResult = { success: true } | { success: false; error: string };

export class FolderBranchSwitch {
  private readonly stashes = new Map<string, { oid: string; at: number }>();

  private topStash(folder: string) {
    return localGit(folder, ["rev-parse", "--verify", "--quiet", "stash@{0}"])
      .then(out => out.trim(), () => "");
  }

  async prepare(folder: string, action: FolderBranchAction, current: () => void): Promise<FolderBranchActionResult> {
    try {
      switch (action.kind) {
        case "stash": {
          const before = await this.topStash(folder);
          current();
          await localGit(folder, ["stash", "push", "-u", "-m", action.message]);
          const oid = await this.topStash(folder);
          if (oid && oid !== before) this.stashes.set(folder, { oid, at: Date.now() });
          break;
        }
        case "commit": {
          current();
          await localGit(folder, ["add", "-A"]).catch(() => {
            throw Error("Could not stage changes for commit.");
          });
          const hidden = (await localGit(folder, ["ls-files", "-v", "-z"]))
            .split("\0").filter(entry => /^[Sa-z] /.test(entry)).length;
          if (hidden)
            throw Error(`Couldn’t commit: ${hidden} tracked ${hidden === 1 ? "file is" : "files are"} hidden from Git by an index flag (skip-worktree or assume-unchanged) and would be left out. Clear the flags with git update-index --no-skip-worktree --no-assume-unchanged, then review the changes.`);
          current();
          await localGit(folder, ["commit", "-m", `WIP: epitaxy pre-switch from ${action.fromBranch}`, "--no-verify"])
            .catch(error => {
              if (!(error instanceof Error && "stdout" in error && typeof error.stdout === "string" &&
                /nothing (?:added )?to commit/.test(error.stdout))) throw error;
            });
          break;
        }
        case "discard":
          current();
          await localGit(folder, ["reset", "--hard"]);
          current();
          await localGit(folder, ["clean", "-fd", "--", ":/"]).catch(() => undefined);
          break;
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: gitError(error) };
    }
  }

  async checkout(folder: string, branch: string, current: () => void) {
    const top = (await localGit(folder, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
    if (!top) return;
    const head = (await localGit(top, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim();
    if (head === `refs/heads/${branch}` || (!head && branch === "HEAD")) return;
    const conflict = await checkBranchSwitchConflict(top, branch);
    current();
    try {
      if (conflict) {
        const from = head ? ` on "${head.slice("refs/heads/".length)}"` : "";
        throw Error(`Can't switch to "${branch}" — there are uncommitted changes${from} in ${folder}. Commit or stash them, or enable "use worktree".`);
      }
      await localGit(top, ["switch", branch]).catch(error => {
        throw Error(`Failed to switch to "${branch}" in ${folder}: ${gitError(error)}`);
      });
      this.stashes.delete(folder);
    } catch (error) {
      const stash = this.stashes.get(folder);
      this.stashes.delete(folder);
      if (stash && Date.now() - stash.at <= 86_400_000 && await this.topStash(top) === stash.oid) {
        current();
        await localGit(top, ["stash", "pop"]).catch(() => undefined);
      }
      throw error;
    }
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
