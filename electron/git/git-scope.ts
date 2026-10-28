import type { GitCommit } from "../../shared/types";
import { isTransportError, type GitRunner } from "./working-tree";

/**
 * The Changes panel's "Diff scope" answers: which branch "All changes" is
 * measured from, the branches it can be compared against, and the branch's own
 * commits. Read-only `git` queries through the folder's host, like the rest of
 * the panel.
 */

/** At most this many of the branch's commits are listed. */
export const MAX_COMMITS = 500;

/** The `git log` format the commit list is read with: sha, short sha, subject. */
const logFormat = "%H%x00%h%x00%an%x00%ct%x00%s%x1e";

/**
 * A branch name the panel may pass back: what git allows in a short ref
 * name, without anything git would read as an option or a range.
 */
export function validBranchName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock")
  );
}

/** A commit id the panel may pass back (an abbreviated or full sha). */
export const validCommitId = (sha: unknown): sha is string =>
  typeof sha === "string" && /^[0-9a-f]{4,64}$/i.test(sha);

/** An empty answer for a query that failed, unless the host itself failed. */
export function ask(git: GitRunner, top: string, args: string[]) {
  return git(top, args, [0, 1])
    .then((out) => out.trim())
    .catch((error) => {
      if (isTransportError(error)) throw error;
      return "";
    });
}

/** The remote the branches are compared on: `origin`, else the first one. */
export async function mainRemote(git: GitRunner, top: string) {
  const names = (await ask(git, top, ["remote"])).split("\n").filter(Boolean);
  return names.includes("origin") ? "origin" : names[0];
}

/**
 * The base branch "All changes" uses: what the remote's HEAD names, else
 * `main` or `master` (on the remote or here), else the checked-out branch
 * itself (the changes are then the uncommitted ones).
 */
export async function defaultBaseBranch(
  git: GitRunner,
  top: string,
  remote: string | undefined,
  branch: string | undefined,
) {
  if (remote) {
    const head = await ask(git, top, [
      "symbolic-ref",
      "--short",
      "-q",
      `refs/remotes/${remote}/HEAD`,
    ]);
    if (head.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
  }
  for (const guess of ["main", "master"])
    for (const ref of [
      ...(remote ? [`refs/remotes/${remote}/${guess}`] : []),
      `refs/heads/${guess}`,
    ])
      if (await ask(git, top, ["rev-parse", "--verify", "-q", ref]))
        return guess;
  return branch;
}

/**
 * The ref a base branch name means, as the original resolves it: the
 * remote's copy first (what the branch will merge into), else the branch
 * here; undefined when neither exists.
 */
export async function resolveBase(
  git: GitRunner,
  top: string,
  remote: string | undefined,
  name: string | undefined,
) {
  if (!validBranchName(name)) return undefined;
  for (const ref of [
    ...(remote ? [`refs/remotes/${remote}/${name}`] : []),
    `refs/heads/${name}`,
  ])
    if (await ask(git, top, ["rev-parse", "--verify", "-q", ref])) return ref;
  return undefined;
}

/** The commits `git log` printed with `logFormat`, newest first. */
export function parseCommits(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of output.split("\x1e")) {
    const [sha, shortSha, author = "", time = "", ...rest] = record
      .replace(/^\n/, "")
      .split("\0");
    const subject = rest.join("\0");
    const at = Number(time) * 1000;
    if (sha && shortSha && /^[0-9a-f]{4,64}$/i.test(sha))
      commits.push({
        sha,
        shortSha,
        subject,
        ...(author ? { author } : {}),
        ...(Number.isFinite(at) && at > 0 ? { at } : {}),
      });
  }
  return commits;
}

/** The branch's commits that `baseRef` lacks, newest first. */
export async function branchCommits(
  git: GitRunner,
  top: string,
  baseRef: string,
) {
  return parseCommits(
    await ask(git, top, [
      "log",
      "--no-show-signature",
      "--no-decorate",
      `--max-count=${MAX_COMMITS}`,
      `--format=${logFormat}`,
      `${baseRef}..HEAD`,
    ]),
  );
}

/** Commits on HEAD that `baseRef` lacks, and the other way round. */
export async function aheadBehind(
  git: GitRunner,
  top: string,
  baseRef: string,
) {
  const [behind, ahead] = (
    await ask(git, top, [
      "rev-list",
      "--left-right",
      "--count",
      `${baseRef}...HEAD`,
    ])
  )
    .split(/\s+/)
    .map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

/**
 * Branch names to compare against: the branches here and the remote's,
 * without the remote's name in front, sorted, the default first and the
 * checked-out branch left out (the original's list).
 */
export function branchChoices(
  names: string[],
  defaultBase: string | undefined,
  current: string | undefined,
) {
  const rest = [...new Set(names)]
    .filter((name) => name !== defaultBase && name !== current)
    .sort((a, b) => a.localeCompare(b));
  return defaultBase && defaultBase !== current ? [defaultBase, ...rest] : rest;
}

/** The repository's branches, for "Compare against". */
export async function listBranches(
  git: GitRunner,
  cwd: string,
): Promise<string[]> {
  let top: string;
  try {
    top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (isTransportError(error)) throw error;
    return [];
  }
  const remote = await mainRemote(git, top);
  const current =
    (await ask(git, top, ["symbolic-ref", "--short", "-q", "HEAD"])) ||
    undefined;
  const refs = (
    await ask(git, top, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
      ...(remote ? [`refs/remotes/${remote}`] : []),
    ])
  )
    .split("\n")
    .filter(Boolean);
  const names: string[] = [];
  for (const ref of refs) {
    const name = ref.startsWith("refs/heads/")
      ? ref.slice("refs/heads/".length)
      : remote && ref.startsWith(`refs/remotes/${remote}/`)
        ? ref.slice(`refs/remotes/${remote}/`.length)
        : undefined;
    if (name && name !== "HEAD" && validBranchName(name)) names.push(name);
  }
  const base = await defaultBaseBranch(git, top, remote, current);
  return branchChoices(names, base, current);
}
