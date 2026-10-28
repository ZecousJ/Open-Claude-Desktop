/**
 * Continue in cloud. A local Code session on a GitHub checkout moves to a cloud
 * session with its work as it is, uncommitted changes included, without pushing
 * the person's branch:
 *
 * 1. `readContinuationPlan` reads the folder's git state (read-only queries):
 *    origin's github.com repository, the branch, what changed, the untracked
 *    files that come along and those that stay (they look like secrets or are
 *    over 10 MB), and what blocks a move (a rebase or merge under way,
 *    conflicts, too many untracked files);
 * 2. `buildSnapshot` saves the work as a commit on top of HEAD, written with an
 *    index of its own in a private temp folder: the folder's own index,
 *    branches and files are untouched, and the commit is reachable from no ref
 *    of theirs ("Saving your work");
 * 3. `uploadForCloud` pushes that commit to a ref of the session's own on
 *    origin with the person's GitHub connection: the service leases a
 *    credential for the one push, POST /api/v1/claudex/web/github/push-grant
 *    ("Uploading your work");
 * 4. the window writes the handoff note (Engine.writeHandOffNote) and sends it
 *    as the first message of a cloud session that checks the commit out on the
 *    desktop's branch name (runner/src/github-workspace.ts).
 *
 * The upload never runs git in the person's folder with the credential: the
 * commit is fetched from the folder into a fresh repository of our own (outside
 * any config or hook of the folder's) and pushed from there, the way the
 * runner's GitHub tools push (runner/src/github-tools.ts). The credential
 * reaches that one git process through a throw-away askpass helper
 * (shared/git-lease.ts) and is dropped when the upload ends.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CloudContinuationPlan,
  CloudSnapshotCensus,
} from "../../shared/cloud-continue-api";
import { githubRepositoryName } from "../git/git-branch";
import {
  gitEnvironment,
  safeGitConfig,
  type GitRunner,
} from "../git/working-tree";

/** Branch names safe as git arguments (git's own rules, roughly). */
export function validBranch(name: string) {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.includes("@{") &&
    !/[\x00-\x20\x7f~^:?*[\\]/.test(name)
  );
}

const trimmed = async (run: Promise<string>) => (await run).trim();

/** A local folder as git's file:// address (a drive letter after a third slash). */
export function fileUrl(folder: string) {
  const forward = folder.split("\\").join("/");
  return forward.startsWith("/") ? `file://${forward}` : `file:///${forward}`;
}

/**
 * The most untracked files a move carries, the largest file, and how many names
 * the dialog lists.
 */
export const maxUntracked = 2000;
export const maxFileBytes = 10 * 1024 * 1024;
const listedNames = 5;

/**
 * File names that look like secrets: they stay on this computer unless the
 * person stages them.
 */
const secretName =
  /^(?:\.env(?:\..+)?|\.envrc|\.npmrc|\.pypirc|\.netrc|_netrc|\.pgpass|\.git-credentials|\.htpasswd|\.s3cfg|\.boto|kubeconfig(?:\.ya?ml)?|(?:token|auth)\.json|(?:application_default_)?credentials(?:\.json|\.ya?ml|\.toml)?|secrets?\.(?:json|ya?ml|toml|env)|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|.+\.(?:pem|key|p12|p8|pfx|jks|keystore|kdbx|ppk|asc)|terraform\.tfstate(?:\.backup)?|.+\.tfvars(?:\.json)?|service-account[^/]*\.json|client_secret[^/]*\.json)$/i;
const exampleEnv =
  /^\.env\.(?:example|sample|template|defaults|dist|schema|test)$/i;
const secretFolder = /^(?:\.ssh|\.aws|\.gnupg|\.docker|\.kube)$/i;

export function looksSecretLike(file: string) {
  const parts = file.split("/");
  const name = parts.at(-1) ?? file;
  return (
    (!exampleEnv.test(name) && secretName.test(name)) ||
    parts.slice(0, -1).some((part) => secretFolder.test(part))
  );
}

/** Files in the git directory that say an operation is under way. */
const operations: [string, string][] = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
  ["sequencer", "cherry-pick"],
];

/** Status codes of an unresolved conflict. */
const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** Everything a snapshot of the folder needs, with full path lists. */
export interface FolderCensus {
  top: string;
  gitDir: string;
  /** "" when HEAD is detached. */
  branch: string;
  /** HEAD's commit; null in a repository without commits. */
  head: string | null;
  repository: string;
  /** Changed tracked paths (relative to `top`). */
  tracked: string[];
  /** Untracked paths that come along. */
  untracked: string[];
  census: CloudSnapshotCensus;
}

export type CensusResult =
  | { kind: "ready"; folder: FolderCensus }
  | Exclude<CloudContinuationPlan, { kind: "ready" }>;

/** How a file of the working tree looks to `lstat` (undefined: unreadable). */
export type StatFile = (
  file: string,
) => Promise<{ file: boolean; size: number } | undefined>;

const statFile: StatFile = async (file) => {
  try {
    const stat = await fs.promises.lstat(file);
    return { file: stat.isFile(), size: stat.size };
  } catch {
    return undefined;
  }
};

/**
 * What continuing this folder in the cloud would carry. Only read-only
 * `git` queries run. A folder that is not a checkout or has no origin on
 * github.com can't continue in the cloud from here.
 */
export async function readCensus(
  git: GitRunner,
  folder: string,
  includeUntracked = true,
  stat: StatFile = statFile,
): Promise<CensusResult> {
  let top: string;
  try {
    top = await trimmed(git(folder, ["rev-parse", "--show-toplevel"]));
  } catch {
    return { kind: "unsupported", reason: "noGit" };
  }
  if (!top) return { kind: "unsupported", reason: "noGit" };
  const symbolic = await trimmed(
    git(top, ["symbolic-ref", "--short", "-q", "HEAD"], [0, 1]),
  ).catch(() => "");
  const branch = validBranch(symbolic) ? symbolic : "";
  const origin = await trimmed(
    git(top, ["config", "--get", "remote.origin.url"], [0, 1]),
  ).catch(() => "");
  const named = branch ? { branch } : {};
  if (!origin) return { kind: "unsupported", reason: "noRemote", ...named };
  const repository = githubRepositoryName(origin);
  if (!repository) return { kind: "unsupported", reason: "noGitHub", ...named };
  const gitDir = await trimmed(
    git(top, ["rev-parse", "--path-format=absolute", "--git-dir"]),
  );
  for (const [file, operation] of operations)
    if (fs.existsSync(path.join(gitDir, file)))
      return { kind: "blocked", blocker: "operation_in_progress", operation };
  const head =
    (await trimmed(
      git(top, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], [0, 1]),
    ).catch(() => "")) || null;
  const status = await git(top, [
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    "--untracked-files=all",
  ]);
  const tracked: string[] = [];
  const untrackedAll: string[] = [];
  for (const entry of status.split("\0")) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (conflictCodes.has(code))
      return { kind: "blocked", blocker: "conflicts" };
    if (code === "??") untrackedAll.push(file);
    else if (code !== "!!") tracked.push(file);
  }
  if (includeUntracked && untrackedAll.length > maxUntracked) {
    const topDirs = [
      ...new Set(
        untrackedAll
          .filter((file) => file.includes("/"))
          .map((file) => file.slice(0, file.indexOf("/"))),
      ),
    ].slice(0, listedNames);
    return {
      kind: "blocked",
      blocker: "too_many_untracked",
      untrackedCount: untrackedAll.length,
      topDirs,
    };
  }
  const untracked: string[] = [];
  const leftBehind: string[] = [];
  const unchecked: string[] = [];
  if (includeUntracked)
    for (const file of untrackedAll) {
      // A folder git lists whole is another repository inside this one.
      const found = file.endsWith("/")
        ? undefined
        : await stat(path.join(top, file));
      if (!found) unchecked.push(file);
      else if (looksSecretLike(file)) leftBehind.push(file);
      else if (found.file && found.size > maxFileBytes) leftBehind.push(file);
      else untracked.push(file);
    }
  let aheadOfUpstream: number | undefined;
  if (branch && head) {
    const tracking = `refs/remotes/origin/${branch}`;
    const known = await trimmed(
      git(top, ["rev-parse", "--verify", "-q", tracking], [0, 1]),
    ).catch(() => "");
    if (known) {
      const count = await trimmed(
        git(top, ["rev-list", "--count", `${tracking}..HEAD`]),
      ).catch(() => "");
      if (/^\d+$/.test(count)) aheadOfUpstream = Number(count);
    }
  }
  return {
    kind: "ready",
    folder: {
      top,
      gitDir,
      branch,
      head,
      repository,
      tracked,
      untracked,
      census: {
        trackedChanges: tracked.length,
        untrackedIncluded: untracked.length,
        ...(aheadOfUpstream !== undefined ? { aheadOfUpstream } : {}),
        leftBehind: leftBehind.slice(0, listedNames),
        leftBehindCount: leftBehind.length,
        unchecked: unchecked.slice(0, listedNames),
        uncheckedCount: unchecked.length,
      },
    },
  };
}

/** The plan the dialog shows (the census without the path lists). */
export async function readContinuationPlan(
  git: GitRunner,
  folder: string,
  includeUntracked = true,
  stat?: StatFile,
): Promise<CloudContinuationPlan> {
  const result = await readCensus(git, folder, includeUntracked, stat);
  if (result.kind !== "ready") return result;
  const { repository, branch, census } = result.folder;
  return { kind: "ready", repository, branch, ...census };
}

/** One git process in the person's folder that may write objects. */
export type PlumbingGit = (
  cwd: string,
  args: string[],
  options: { env: Record<string, string>; stdin?: string },
) => Promise<string>;

const runPlumbing: PlumbingGit = (cwd, args, { env, stdin }) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...safeGitConfig, "-c", "core.splitIndex=false", ...args],
      {
        cwd,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...gitEnvironment, ...env },
      },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
    child.stdin?.end(stdin ?? "");
  });

/** The snapshot commit's message. */
export const snapshotSubject = "WIP: uncommitted changes, moved to the cloud";
const snapshotMessage = `${snapshotSubject}

Snapshot of the working tree the Claudex desktop app took to continue
this session in the cloud. It was never committed on the desktop; fold
it into your next commit (git commit --amend) or unstage it
(git reset --mixed HEAD~1) before committing for real.
`;
/** Who made it when the folder's git has no identity of its own. */
const fallbackIdentity = {
  GIT_AUTHOR_NAME: "Claudex",
  GIT_AUTHOR_EMAIL: "noreply@claudex.invalid",
  GIT_COMMITTER_NAME: "Claudex",
  GIT_COMMITTER_EMAIL: "noreply@claudex.invalid",
};

export interface SavedSnapshot {
  /** The commit the cloud session starts from. */
  tip: string;
  /** false: nothing was uncommitted, the tip is HEAD. */
  snapshot: boolean;
}

/**
 * Saves the folder's work as a commit whose parent is HEAD, with an index
 * of its own (GIT_INDEX_FILE in a private temp folder). The commit's dates
 * are HEAD's, so the same work saves as the same commit every time (an
 * upload made outside this app is recognised).
 */
export async function buildSnapshot(
  folder: FolderCensus,
  options: { run?: PlumbingGit; tempRoot?: string } = {},
): Promise<SavedSnapshot> {
  const run = options.run ?? runPlumbing;
  const { top, head } = folder;
  const paths = [...new Set([...folder.tracked, ...folder.untracked])];
  if (!paths.length) {
    if (!head)
      throw new Error(
        "This repository has no commits and nothing to save yet. Commit something first, then try again.",
      );
    return { tip: head, snapshot: false };
  }
  const temp = fs.mkdtempSync(
    path.join(options.tempRoot ?? os.tmpdir(), "claudex-snapshot-"),
  );
  fs.chmodSync(temp, 0o700);
  try {
    const env = { GIT_INDEX_FILE: path.join(temp, "index") };
    if (head) await run(top, ["read-tree", head], { env });
    const stage = (list: string[]) =>
      run(
        top,
        ["update-index", "--add", "--remove", "--replace", "-z", "--stdin"],
        {
          env,
          stdin: `${list.join("\0")}\0`,
        },
      );
    try {
      await stage(paths);
    } catch {
      // One unreadable file must not stop the rest.
      for (const file of paths) await stage([file]).catch(() => undefined);
    }
    const tree = (await run(top, ["write-tree"], { env })).trim();
    if (head) {
      const headTree = (
        await run(top, ["rev-parse", `${head}^{tree}`], { env })
      ).trim();
      if (tree === headTree) return { tip: head, snapshot: false };
    }
    let seconds = 1_000_000_000;
    if (head) {
      const at = Number.parseInt(
        (await run(top, ["log", "-1", "--format=%ct", head], { env })).trim(),
        10,
      );
      if (at >= 100_000_000) seconds = at;
    }
    const dated = {
      ...env,
      GIT_AUTHOR_DATE: `${seconds} +0000`,
      GIT_COMMITTER_DATE: `${seconds} +0000`,
    };
    const argv = [
      "commit-tree",
      tree,
      ...(head ? ["-p", head] : []),
      "-F",
      "-",
    ];
    let commit: string;
    try {
      commit = (
        await run(top, argv, { env: dated, stdin: snapshotMessage })
      ).trim();
    } catch {
      commit = (
        await run(top, argv, {
          env: { ...dated, ...fallbackIdentity },
          stdin: snapshotMessage,
        })
      ).trim();
    }
    if (!/^[0-9a-f]{40,64}$/.test(commit))
      throw new Error(
        "Couldn’t read this folder’s git state. Check again in a moment.",
      );
    return { tip: commit, snapshot: true };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** The session's own ref the work is uploaded to (never a branch). */
export function transportRef(conversationId: string) {
  return `refs/claudex-continue/${createHash("sha256")
    .update(conversationId)
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * The folder's shared git directory, where its objects are (a linked
 * worktree's live in the main checkout's).
 */
export async function commonGitDir(git: GitRunner, folder: string) {
  const dir = await trimmed(
    git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  if (!dir || !path.isAbsolute(dir))
    throw new Error(
      "Couldn’t read this folder’s git state. Check again in a moment.",
    );
  return dir;
}
