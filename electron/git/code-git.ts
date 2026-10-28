import type { CodeGitStatus } from "../../shared/panels-api";
import { githubRepositoryName } from "./git-branch";
import {
  isTransportError,
  localWorkingTree,
  type WorkingTreeHost,
} from "./working-tree";

/**
 * What a Code session's pull request row shows about the folder's branch, from
 * read-only `git` queries run where the Changes panel's run: on this computer,
 * on an SSH host, or in the web runner's sandbox (`WorkingTreeHost`). The
 * folder is one the agent writes to, so nothing here runs a program from its
 * configuration.
 */

/** The remote the branch belongs to: `origin`, else the first with a GitHub address. */
export function pickRemote(listing: string) {
  const remotes: { name: string; url: string }[] = [];
  for (const line of listing.split("\n")) {
    const match = /^remote\.(.+)\.(?:url|pushurl) (.+)$/.exec(line.trim());
    if (match) remotes.push({ name: match[1], url: match[2].trim() });
  }
  const github = remotes.filter((remote) => githubRepositoryName(remote.url));
  const chosen =
    github.find((remote) => remote.name === "origin") ??
    github[0] ??
    remotes.find((remote) => remote.name === "origin");
  return chosen
    ? {
        name: chosen.name,
        repository: githubRepositoryName(chosen.url),
      }
    : undefined;
}

/** Lines added and removed in `git diff --numstat` (binary files count nothing). */
export function numstatTotals(numstat: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!match) continue;
    if (match[1] !== "-") additions += Number(match[1]);
    if (match[2] !== "-") deletions += Number(match[2]);
  }
  return { additions, deletions };
}

export async function codeGitStatus(
  cwd: string | undefined,
  host: WorkingTreeHost = localWorkingTree,
): Promise<CodeGitStatus> {
  const empty = {
    ahead: 0,
    behind: 0,
    pushed: false,
    dirty: false,
    additions: 0,
    deletions: 0,
  };
  if (!cwd) return { state: "no-folder", ...empty };
  const git = host.git;
  // A query that fails reads as an empty answer, unless the host itself failed.
  const ask = (top: string, args: string[], okCodes: number[] = [0, 1]) =>
    git(top, args, okCodes)
      .then((out) => out.trim())
      .catch((error) => {
        if (isTransportError(error)) throw error;
        return "";
      });
  let top: string;
  try {
    top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (isTransportError(error)) throw error;
    return { state: "not-git", ...empty };
  }
  const branch = await ask(top, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const remote = pickRemote(
    await ask(top, ["config", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"]),
  );
  // The remote's default branch: what origin/HEAD points at, else main/master.
  let base = "";
  let baseRef = "";
  if (remote) {
    const head = await ask(top, [
      "symbolic-ref",
      "--short",
      "-q",
      `refs/remotes/${remote.name}/HEAD`,
    ]);
    const prefix = `${remote.name}/`;
    if (head.startsWith(prefix)) base = head.slice(prefix.length);
    if (!base)
      for (const guess of ["main", "master"])
        if (
          await ask(top, [
            "rev-parse",
            "--verify",
            "-q",
            `refs/remotes/${remote.name}/${guess}`,
          ])
        ) {
          base = guess;
          break;
        }
    if (base) baseRef = `${remote.name}/${base}`;
  }
  const head = await ask(top, ["rev-parse", "--verify", "-q", "HEAD"]);
  const ahead =
    head && baseRef
      ? Number(await ask(top, ["rev-list", "--count", `${baseRef}..HEAD`])) || 0
      : 0;
  // What the base gained since the branch left it (the row's ↓ count).
  const behind =
    head && baseRef
      ? Number(await ask(top, ["rev-list", "--count", `HEAD..${baseRef}`])) || 0
      : 0;
  const pushed = Boolean(
    remote &&
    branch &&
    (await ask(top, [
      "rev-parse",
      "--verify",
      "-q",
      `refs/remotes/${remote.name}/${branch}`,
    ])),
  );
  const dirty = Boolean(
    await ask(top, ["status", "--porcelain", "--untracked-files=normal"], [0]),
  );
  const mergeBase =
    head && baseRef ? await ask(top, ["merge-base", baseRef, "HEAD"]) : "";
  const against = mergeBase || head;
  const { additions, deletions } = against
    ? numstatTotals(
        await ask(
          top,
          ["diff", "--numstat", "--no-ext-diff", "--no-textconv", against],
          [0],
        ),
      )
    : { additions: 0, deletions: 0 };
  return {
    state: "ready",
    ...(branch ? { branch } : {}),
    ...(base ? { baseBranch: base } : {}),
    ...(remote?.repository ? { repository: remote.repository } : {}),
    ahead,
    behind,
    pushed,
    dirty,
    additions,
    deletions,
  };
}
