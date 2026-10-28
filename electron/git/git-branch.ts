/**
 * The Git branch and remotes of a working folder, for the Code home's branch
 * chip and the Import GitHub issue row.
 *
 * Only plain files under the repository's `.git` are read: no `git` process
 * runs, so nothing in the repository's configuration (hooks, `core.fsmonitor`,
 * credential helpers, includes) can execute or be followed.
 *
 * A folder on an SSH host (R9) can't be read that way; `workspaceGitWith` asks
 * the host's `git` instead, with the same safe settings as the Changes panel
 * (no fsmonitor, no pager, no optional locks).
 */
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceGit } from "../../shared/code-usage-api";
import { isTransportError, type GitRunner } from "./working-tree";

/** Git files are small; anything larger is not what we expect and is skipped. */
const maxBytes = 256 * 1024;

function readSmall(file: string) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The repository's git directory and its common directory (they differ in a
 * linked worktree), looking upwards from the folder.
 */
export function gitDirectories(folder: string) {
  let current = path.resolve(folder);
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = path.join(current, ".git");
    let gitDir: string | undefined;
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) gitDir = dotGit;
      else if (stat.isFile()) {
        // A worktree or submodule: ".git" names the real directory.
        const pointer = readSmall(dotGit)?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
        if (pointer) gitDir = path.resolve(current, pointer);
      }
    } catch {
      // Not here; keep looking upwards.
    }
    if (gitDir) {
      const common = readSmall(path.join(gitDir, "commondir"))?.trim();
      return {
        gitDir,
        commonDir: common ? path.resolve(gitDir, common) : gitDir,
      };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** The branch named by a HEAD file. */
export function branchFromHead(head: string | undefined): string | null {
  if (!head) return null;
  const ref = head.match(/^ref:\s*refs\/heads\/(\S+)\s*$/m)?.[1];
  if (ref) return ref;
  const commit = head.trim().match(/^[0-9a-f]{40,64}$/i)?.[0];
  return commit ? commit.slice(0, 7) : null;
}

/** Whether a git config file lists a remote on github.com. */
export function hasGithubRemote(config: string | undefined) {
  if (!config) return false;
  let inRemote = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inRemote = /^\[remote\s+"[^"]*"\]$/.test(line);
      continue;
    }
    if (!inRemote) continue;
    const url = line.match(/^(?:url|pushurl)\s*=\s*(.+)$/i)?.[1]?.trim();
    if (url && githubUrl(url.replace(/^"(.*)"$/, "$1"))) return true;
  }
  return false;
}

/** https://github.com/…, ssh://git@github.com/… and git@github.com:… */
export function githubUrl(url: string) {
  const scp = url.match(/^[\w.-]+@([\w.-]+):/);
  if (scp) return scp[1].toLowerCase() === "github.com";
  try {
    return new URL(url).hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

export function workspaceGit(folder: string): WorkspaceGit {
  const dirs = gitDirectories(folder);
  if (!dirs) return { branch: null, githubRemote: false };
  return {
    branch: branchFromHead(readSmall(path.join(dirs.gitDir, "HEAD"))),
    githubRemote: hasGithubRemote(
      readSmall(path.join(dirs.commonDir, "config")),
    ),
  };
}

/**
 * The same answer through read-only `git` queries, for a folder that is not
 * on this computer (an SSH host's, R9): the branch HEAD names (or the short
 * commit when detached), and whether a remote's URL is on github.com.
 * Outside a repository both are empty; a host that can't be reached throws.
 */
export async function workspaceGitWith(
  git: GitRunner,
  folder: string,
): Promise<WorkspaceGit> {
  const none: WorkspaceGit = { branch: null, githubRemote: false };
  let branch: string | null;
  try {
    const name = (
      await git(folder, ["symbolic-ref", "--short", "-q", "HEAD"], [0, 1])
    ).trim();
    if (name) branch = name;
    else {
      const commit = (
        await git(folder, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1])
      ).trim();
      branch = /^[0-9a-f]{40,64}$/i.test(commit) ? commit.slice(0, 7) : null;
    }
  } catch (error) {
    if (isTransportError(error)) throw error;
    return none;
  }
  let githubRemote = false;
  try {
    const urls = await git(
      folder,
      ["config", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"],
      [0, 1],
    );
    githubRemote = urls
      .split("\n")
      .map((line) => line.slice(line.indexOf(" ") + 1).trim())
      .some((url) => url && githubUrl(url));
  } catch (error) {
    if (isTransportError(error)) throw error;
  }
  return { branch, githubRemote };
}

/**
 * "owner/name" of a github.com remote address (https, ssh:// and
 * git@github.com: forms), or undefined for another host or a path that
 * isn't a repository.
 */
export function githubRepositoryName(url: string) {
  const address = url.trim().replace(/^"(.*)"$/, "$1");
  if (!githubUrl(address)) return undefined;
  const scp = address.match(/^[\w.-]+@[\w.-]+:(.+)$/);
  let pathname = scp?.[1];
  if (pathname === undefined) {
    try {
      pathname = new URL(address).pathname;
    } catch {
      return undefined;
    }
  }
  const match = pathname
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .match(/^([^/\s]+)\/([^/\s]+)$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** The github.com repository a git config's remotes name, `origin` first. */
export function githubRepositoryIn(config: string | undefined) {
  if (!config) return undefined;
  const found: { remote: string; repository: string }[] = [];
  let remote: string | undefined;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      remote = line.match(/^\[remote\s+"([^"]*)"\]$/)?.[1];
      continue;
    }
    if (remote === undefined) continue;
    const url = line.match(/^url\s*=\s*(.+)$/i)?.[1];
    const repository = url ? githubRepositoryName(url) : undefined;
    if (repository) found.push({ remote, repository });
  }
  return (found.find((item) => item.remote === "origin") ?? found[0])
    ?.repository;
}

/** The github.com repository of a folder's remotes, read from files only. */
export function workspaceRepository(folder: string) {
  const dirs = gitDirectories(folder);
  return dirs
    ? githubRepositoryIn(readSmall(path.join(dirs.commonDir, "config")))
    : undefined;
}
