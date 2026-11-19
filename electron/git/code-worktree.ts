import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Conversation, SessionFolderWorktree, SessionWorktree } from "../../shared/types";
import { realFolder } from "../workspace/workspace-trust";
import { gitEnvironment, safeGitConfig } from "./working-tree";

/**
 * A Code session's own worktree (live claude.ai bundle, 2026-10-14: the
 * Worktree switch under the folder chip, "Works in its own worktree"). The
 * session runs in a new branch checked out beside the folder's repository,
 * so sessions in one folder keep their changes apart. With no location set
 * the worktrees live inside the repository under .claude/worktrees (kept out
 * of its status by .git/info/exclude); a location puts them in
 * <location>/<repository name>/. Archiving or deleting the session removes
 * a clean worktree and keeps one with changes; the branch always stays.
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
export function worktreeName(branchHint?: string) {
  const hint = branchHint?.slice(branchHint.lastIndexOf("/") + 1)
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  return `${hint || `${pick(adjectives)}-${pick(names)}`}-${randomBytes(3).toString("hex")}`;
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
  signal?: AbortSignal,
) => Promise<string>;

export const localGit: Git = (cwd, args, timeout = 30_000, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = execFile(
      "git",
      [...safeGitConfig, ...args],
      {
        cwd,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        signal,
        env: { ...process.env, ...gitEnvironment, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout));
        const failure = error as NodeJS.ErrnoException & { stderr?: string };
        failure.stderr = String(stderr || "");
        // Abort can reach execFile's callback before Git has stopped writing.
        if (
          signal?.aborted &&
          child.pid &&
          child.exitCode === null &&
          child.signalCode === null
        )
          child.once("exit", () => reject(failure));
        else reject(failure);
      },
    );
  });

const missingGit = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

function worktreeParent(top: string, location: string) {
  const custom = location.trim();
  const inside = !custom || !path.isAbsolute(custom);
  const repoName = path.basename(top);
  const candidate = path.resolve(custom, repoName);
  const sameRepository = process.platform === "win32"
    ? candidate.toLowerCase() === top.toLowerCase()
    : candidate === top;
  const parent = inside
    ? path.join(top, ".claude", "worktrees")
    : sameRepository ? path.join(custom, `${repoName}-worktrees`) : candidate;
  return { parent, inside };
}

/** Plan before changing Git, so a restarted first send reuses the same tree. */
export async function planRemoteCodeWorktree(folder: string, location: string, prefix: string) {
  const top = path.resolve((await localGit(folder, ["rev-parse", "--show-toplevel"])).trim());
  const relative = path.relative(realFolder(top), realFolder(folder));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw Error("The remote Code folder is outside its repository.");
  const commit = (await localGit(top, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const { parent } = worktreeParent(top, location);
  let name = worktreeName();
  while (fs.existsSync(path.join(parent, name))) name = worktreeName();
  return { path: path.join(parent, name), branch: worktreeBranch(prefix, name), repository: top,
    origin: path.resolve(folder), name, commit };
}

export async function cleanupRemoteCodeWorktree(plan: SessionWorktree & { commit: string }) {
  try {
    const ref = (await localGit(plan.repository, ["rev-parse", "--verify", `refs/heads/${plan.branch}`])).trim();
    if (ref !== plan.commit) return;
    if (fs.existsSync(plan.path)) {
      if (!await isRecordedWorktree(plan, localGit)) return;
      const [head, status] = await Promise.all([
        localGit(plan.path, ["rev-parse", "--verify", "HEAD"]),
        localGit(plan.path, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"]),
      ]);
      if (head.trim() !== plan.commit || status.trim()) return;
      await localGit(plan.repository, ["worktree", "remove", plan.path]);
    } else {
      const listed = await localGit(plan.repository, ["worktree", "list", "--porcelain", "-z"]);
      if (listed.split("\0").some(line => line.startsWith("worktree ") &&
          realFolder(line.slice("worktree ".length)) === realFolder(plan.path)))
        await localGit(plan.repository, ["worktree", "remove", plan.path]);
    }
    const [current, listed] = await Promise.all([
      localGit(plan.repository, ["rev-parse", "--verify", `refs/heads/${plan.branch}`]),
      localGit(plan.repository, ["worktree", "list", "--porcelain", "-z"]),
    ]);
    if (current.trim() === plan.commit && !listed.split("\0").includes(`branch refs/heads/${plan.branch}`))
      await localGit(plan.repository, ["branch", "-D", "--", plan.branch]);
  } catch {
    // Preserve anything that cannot be proven safe to remove.
  }
}

export async function materializeRemoteCodeWorktree(
  plan: SessionWorktree & { commit: string }, checkCurrent: () => void, signal?: AbortSignal,
) {
  checkCurrent();
  signal?.throwIfAborted();
  if (fs.existsSync(plan.path)) {
    if (!await isRecordedWorktree(plan, localGit)) throw Error("Another folder occupies the planned Code worktree.");
  } else {
    // A crash may have left a registration or branch without a checkout. Never
    // adopt an unrelated branch: only a matching commit is safe to resume.
    const ref = await localGit(plan.repository, ["rev-parse", "--verify", `refs/heads/${plan.branch}`]).then(x => x.trim(), () => "");
    if (ref && ref !== plan.commit) throw Error("The planned Code worktree branch has changed.");
    checkCurrent();
    await clearMissingWorktreeRegistration(plan, localGit, checkCurrent);
    checkCurrent();
    if (path.dirname(plan.path) === path.join(plan.repository, ".claude", "worktrees"))
      await excludeWorktrees(localGit, plan.repository, checkCurrent);
    checkCurrent();
    fs.mkdirSync(path.dirname(plan.path), { recursive: true });
    await localGit(plan.repository, ["-c", "core.longpaths=true", "worktree", "add", "--no-track",
      ...(ref ? [] : ["-b", plan.branch]), plan.path, ref ? plan.branch : plan.commit], 10 * 60_000, signal);
  }
  checkCurrent();
  signal?.throwIfAborted();
  return { worktree: plan, cwd: createWorktreeFolder(plan, plan.origin) };
}

/** Keeps the in-repository worktrees out of the folder's own status. */
async function excludeWorktrees(git: Git, top: string, checkCurrent?: () => void) {
  try {
    const file = path.resolve(
      top,
      (await git(top, ["rev-parse", "--git-path", "info/exclude"])).trim(),
    );
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (/^\/?\.claude\/worktrees\/?$/m.test(text)) return;
    checkCurrent?.();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${text && !text.endsWith("\n") ? "\n" : ""}/.claude/worktrees/\n`,
    );
  } catch {}
}

type WorktreeGitRead = (args: string[]) => Promise<string>;
const originRefs = "refs/remotes/origin/";

function readRef(run: WorktreeGitRead, name: string) {
  return run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`])
    .then(value => value.trim(), () => "");
}

export async function resolveWorktreeSource(sourceBranch: string, run: WorktreeGitRead) {
  if (!sourceBranch || sourceBranch.startsWith("-")) return;
  if (/^[0-9a-f]{40,64}$/i.test(sourceBranch)) {
    const commit = await readRef(run, sourceBranch);
    return commit ? { commit, sourceBranch } : undefined;
  }
  const [local, tracking] = await Promise.all([
    readRef(run, `refs/heads/${sourceBranch}`),
    sourceBranch.startsWith("origin/")
      ? readRef(run, `refs/remotes/${sourceBranch}`)
      : readRef(run, `${originRefs}${sourceBranch}`).then(commit => commit ||
        (sourceBranch.includes("/") ? readRef(run, `refs/remotes/${sourceBranch}`) : "")),
  ]);
  if (!tracking) return local ? { commit: local, sourceBranch } : undefined;
  if (!local || local === tracking) return { commit: tracking, sourceBranch };
  const base = await run(["merge-base", tracking, local]).then(value => value.trim(), () => "");
  if (base && base !== local) {
    const sameConfig = await run([
      "-c", "diff.relative=false", "diff", "--quiet", "--no-ext-diff", "--no-textconv",
      "--submodule=short", base, local, "--", ":(top,icase).claude", ":(top,icase).mcp.json",
    ]).then(() => true, () => false);
    if (sameConfig) return { commit: local, sourceBranch };
  }
  return { commit: tracking, sourceBranch };
}

async function worktreeStart(top: string, requested: string | undefined, git: Git, signal?: AbortSignal) {
  const run = (args: string[]) => git(top, args, 5_000, signal);
  const read = (args: string[]) => run(args).then(value => value.trim(), () => "");
  const hasOrigin = Boolean(await read(["remote", "get-url", "origin"]));
  let sourceBranch = requested;
  let discoveredDefault = false;
  if (sourceBranch === undefined) {
    const [directory, common] = (await read([
      "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir",
    ])).split(/\r?\n/);
    if (directory && directory === common) {
      const target = await read(["symbolic-ref", "-q", `${originRefs}HEAD`]);
      if (target.startsWith(originRefs)) sourceBranch = target.slice(originRefs.length);
      else if (await readRef(run, `${originRefs}main`)) sourceBranch = "main";
      else if (await readRef(run, `${originRefs}master`)) sourceBranch = "master";
      else if (hasOrigin) {
        const head = await read(["ls-remote", "--symref", "origin", "HEAD"]);
        sourceBranch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1];
        discoveredDefault = sourceBranch !== undefined;
      }
    }
  }
  if (hasOrigin && sourceBranch && sourceBranch !== "HEAD" &&
    !sourceBranch.startsWith("origin/") && !sourceBranch.startsWith("refs/") &&
    !sourceBranch.startsWith("-") && !/^[0-9a-f]{40,64}$/i.test(sourceBranch)) {
    const head = `refs/heads/${sourceBranch}`;
    const tracking = `${originRefs}${sourceBranch}`;
    const valid = await run(["check-ref-format", head]).then(() => true, () => false);
    if (valid && !await read(["symbolic-ref", "-q", tracking])) {
      const fetched = await git(top, [
        "fetch", "--no-tags", "--no-prune", "--no-write-fetch-head",
        "--no-recurse-submodules", "--refmap=", "origin", `+${head}:${tracking}`,
      ], 10_000, signal).then(() => true, () => false);
      if (fetched && discoveredDefault)
        await read(["symbolic-ref", `${originRefs}HEAD`, tracking]);
    }
  }
  const start = sourceBranch && await resolveWorktreeSource(sourceBranch, run);
  if (start) return start;
  const [commit, branch] = await Promise.all([
    readRef(run, "HEAD"),
    read(["symbolic-ref", "-q", "HEAD"]),
  ]);
  return { commit, sourceBranch: branch.startsWith("refs/heads/") ? branch.slice(11) : undefined };
}

export async function createSessionWorktree(
  folder: string,
  {
    location = "",
    prefix = "claude",
    startBranch,
    branchHint,
    git = localGit,
    signal,
  }: {
    location?: string;
    prefix?: string;
    startBranch?: string;
    branchHint?: string;
    git?: Git;
    signal?: AbortSignal;
  } = {},
): Promise<{ worktree: SessionWorktree; cwd: string }> {
  signal?.throwIfAborted();
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
  const start = await worktreeStart(top, startBranch, git, signal);
  signal?.throwIfAborted();
  if (!start.commit) {
    throw new WorktreeError(
      "This repository has no commits yet, so a worktree can't start from it. Make a first commit, or turn off Worktree.",
      "no-commits",
    );
  }
  // Only an absolute folder counts as a location (Settings picks one).
  const { parent, inside } = worktreeParent(top, location);
  let name = worktreeName(branchHint);
  while (fs.existsSync(path.join(parent, name))) name = worktreeName(branchHint);
  const target = path.join(parent, name);
  const branch = worktreeBranch(prefix, name);
  if (inside) await excludeWorktrees(git, top);
  signal?.throwIfAborted();
  const worktree = {
    path: target,
    branch,
    repository: top,
    origin: path.resolve(folder),
    name,
    ...(start.sourceBranch ? { sourceBranch: start.sourceBranch } : {}),
  };
  try {
    fs.mkdirSync(parent, { recursive: true });
    // Checking out a large repository can take minutes.
    await git(
      top,
      [
        "-c",
        "core.longpaths=true",
        "worktree",
        "add",
        "--no-track",
        "-b",
        branch,
        target,
        start.commit,
      ],
      10 * 60_000,
      signal,
    );
    signal?.throwIfAborted();
    return { worktree, cwd: createWorktreeFolder(worktree, folder) };
  } catch (error) {
    if (signal?.aborted || fs.existsSync(target))
      await cleanupCancelledSessionWorktree(worktree, git);
    signal?.throwIfAborted();
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
}

function isInside(root: string, folder: string) {
  const relative = path.relative(root, folder);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function ensureWorktreeDirectory(root: string, cwd: string) {
  let existing = cwd;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (!isInside(root, cwd) || !isInside(realFolder(root), realFolder(existing)))
    throw Error("The session folder is outside its worktree.");
  fs.mkdirSync(cwd, { recursive: true });
}

function createWorktreeFolder(worktree: SessionWorktree, folder: string, repository = worktree.repository) {
  const relative = path.relative(repository, realFolder(folder));
  const cwd =
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? path.join(worktree.path, relative)
      : worktree.path;
  ensureWorktreeDirectory(worktree.path, cwd);
  return cwd;
}

type SessionWorktreeOptions = {
  location: string;
  prefix: string;
  startBranch?: string;
  branchHint?: string;
  signal?: AbortSignal;
};

export interface SessionWorktreeOperations {
  kind: "local" | "remote";
  create(folder: string, options: SessionWorktreeOptions): Promise<{ worktree: SessionWorktree; cwd: string }>;
  repositoryOf(folder: string, signal?: AbortSignal): Promise<{ key: string; root: string } | undefined>;
  mapFolder(worktree: SessionWorktree, folder: string, repository: string): string | Promise<string>;
  cleanupCancelled(worktree: SessionWorktree): Promise<void>;
  isInside(root: string, folder: string): boolean;
}

export const localSessionWorktreeOperations: SessionWorktreeOperations = {
  kind: "local",
  create: createSessionWorktree,
  async repositoryOf(folder, signal) {
    const result = await localGit(folder, [
      "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel",
    ], 4_000, signal).catch(() => undefined);
    const [common, root] = result?.trimEnd().split("\n") ?? [];
    return common && root ? { key: realFolder(common), root } : undefined;
  },
  mapFolder: createWorktreeFolder,
  cleanupCancelled: cleanupCancelledSessionWorktree,
  isInside,
};

const noticePath = (value: string) => value.replace(/[`<>]/g, "?");

export async function createSessionWorkspace({
  cwd,
  primary,
  additionalFolders,
  requested,
  isTrusted,
  checkCurrent,
  options,
  operations = localSessionWorktreeOperations,
}: {
  cwd: string;
  primary?: { sourceBranch?: string };
  additionalFolders?: string[];
  requested?: { path: string; sourceBranch?: string }[];
  isTrusted?: (folder: string) => boolean | Promise<boolean>;
  checkCurrent: () => void;
  options: SessionWorktreeOptions;
  operations?: SessionWorktreeOperations;
}) {
  let worktree: SessionWorktree | undefined;
  const additionalWorktrees: SessionFolderWorktree[] = [];
  const notices: string[] = [];
  try {
    if (primary) {
      const made = await operations.create(cwd, {
        ...options,
        startBranch: primary.sourceBranch,
      });
      worktree = made.worktree;
      cwd = made.cwd;
      checkCurrent();
      if (operations.kind === "local" && primary.sourceBranch && primary.sourceBranch !== worktree.sourceBranch) {
        const fallback = worktree.sourceBranch
          ? `\`${noticePath(worktree.sourceBranch)}\`, the folder's current branch.`
          : "the commit the folder is on.";
        notices.push(`Branch \`${noticePath(primary.sourceBranch)}\` couldn't be used, so this session's worktree starts from ${fallback}`);
      }
    }
    if (!requested?.length) return { cwd, worktree, additionalFolders, additionalWorktrees, notices };

    const repositoryOf = async (folder: string) => {
      const result = await operations.repositoryOf(folder, options.signal);
      checkCurrent();
      return result;
    };
    const primaryRepo = await repositoryOf(cwd);
    const leases = new Map<string, SessionFolderWorktree | "in-place" | "untrusted">();
    const choices = new Map(requested.map(choice => [choice.path, choice]));
    const folders: string[] = [];
    const untrustedNotice = (folder: string) =>
      `\`${noticePath(folder)}\` isn’t a trusted folder, so it was left out of this session. Open a session there once to trust it.`;
    const failedNotice = (folder: string) =>
      `A worktree couldn’t be created for \`${noticePath(folder)}\`, so this session uses that folder in place.`;
    for (const folder of additionalFolders ?? []) {
      const choice = choices.get(folder);
      if (choice && operations.kind === "remote" && isTrusted && !await isTrusted(folder)) {
        checkCurrent();
        notices.push(untrustedNotice(folder));
        continue;
      }
      const repo = choice && await repositoryOf(folder);
      if (!choice || !repo || repo.key === primaryRepo?.key) {
        folders.push(folder);
        continue;
      }
      let lease = leases.get(repo.key);
      let mapped: string | undefined;
      if (!lease) {
        if (operations.kind === "local" && isTrusted && !await isTrusted(folder)) lease = "untrusted";
        else {
          checkCurrent();
          try {
            const made = await operations.create(folder, {
              ...options,
              startBranch: choice.sourceBranch,
            });
            lease = { ...made.worktree, folders: [] };
            mapped = made.cwd;
            additionalWorktrees.push(lease);
          } catch (error) {
            if (!(error instanceof WorktreeError)) throw error;
            lease = "in-place";
            notices.push(failedNotice(folder));
          }
          checkCurrent();
        }
        leases.set(repo.key, lease);
      }
      if (lease === "untrusted") {
        notices.push(untrustedNotice(folder));
        continue;
      }
      if (lease === "in-place") {
        folders.push(folder);
        continue;
      }
      try {
        mapped ??= await operations.mapFolder(lease, folder, repo.root);
      } catch {
        notices.push(failedNotice(folder));
        folders.push(folder);
        continue;
      }
      checkCurrent();
      lease.folders.push({ origin: folder, repository: repo.root, cwd: mapped });
      if (operations.kind === "local" && !operations.isInside(repo.root, lease.path))
        folders.push(folder);
      folders.push(mapped);
    }
    return { cwd, worktree, additionalFolders: [...new Set(folders)], additionalWorktrees, notices };
  } catch (error) {
    await Promise.allSettled([
      ...(worktree ? [operations.cleanupCancelled(worktree)] : []),
      ...additionalWorktrees.map(tree => operations.cleanupCancelled(tree)),
    ]);
    throw error;
  }
}

export async function cleanupCancelledSessionWorktree(
  worktree: SessionWorktree,
  git: Git = localGit,
) {
  try {
    await git(worktree.repository, [
      "-c",
      "core.longpaths=true",
      "worktree",
      "remove",
      "--force",
      worktree.path,
    ]);
  } catch {
    fs.rmSync(worktree.path, { recursive: true, force: true });
  }
  await git(worktree.repository, ["branch", "-D", "--", worktree.branch]).catch(
    () => {},
  );
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

export type SessionWorktreeProbe = {
  folder: string;
  worktreePath: string;
  primary?: true;
} & ({ changes: string[]; unreadable?: never } | { unreadable: true; changes?: never });

export function conversationWorktrees(c: Pick<Conversation, "worktree" | "additionalWorktrees">) {
  return [...(c.worktree ? [c.worktree] : []), ...(c.additionalWorktrees ?? [])];
}

export function ownsLocalCodeWorktreePath(c: Conversation, folder: string) {
  return c.mode === "code" && (c.environment?.kind ?? "local") === "local" &&
    !c.cloudHosted && !c.cloudEnvironmentId &&
    (c.worktree?.state !== "deleted" && c.worktree?.path === folder ||
      c.additionalWorktrees?.some(tree => tree.state !== "deleted" &&
        (tree.path === folder || tree.folders.some(entry => entry.cwd === folder))));
}

export async function probeSessionWorktree(
  worktree: SessionWorktree,
  primary = true,
): Promise<SessionWorktreeProbe> {
  const folder: Pick<SessionWorktreeProbe, "folder" | "worktreePath" | "primary"> = {
    folder: worktree.origin,
    worktreePath: worktree.path,
    ...(primary ? { primary: true } : {}),
  };
  try {
    if (!localSessionWorktreePresent(worktree))
      return { ...folder, unreadable: true };
    const status = await localGit(worktree.path, [
      "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
    ], 4_000);
    return { ...folder, changes: status.split("\n").filter(Boolean) };
  } catch {
    return { ...folder, unreadable: true };
  }
}

export function localSessionWorktreePresent(worktree: SessionWorktree) {
  try {
    const marker = fs.readFileSync(path.join(worktree.path, ".git"), "utf8");
    return marker.startsWith("gitdir: ");
  } catch {
    return false;
  }
}

export async function isRecordedWorktree(worktree: SessionWorktree, git: Git = localGit) {
  if (!localSessionWorktreePresent(worktree)) return false;
  const args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
  try {
    const [repository, checkout, registered] = await Promise.all([
      git(worktree.repository, args),
      git(worktree.path, [...args, "--symbolic-full-name", "HEAD"]),
      git(worktree.repository, ["worktree", "list", "--porcelain", "-z"]),
    ]);
    const [common, branch] = checkout.trimEnd().split("\n");
    return branch === `refs/heads/${worktree.branch}` &&
      realFolder(repository.trimEnd()) === realFolder(common) &&
      registered.split("\0").some(line => line.startsWith("worktree ") &&
        realFolder(line.slice("worktree ".length)) === realFolder(worktree.path));
  } catch {
    return false;
  }
}

async function clearMissingWorktreeRegistration(worktree: SessionWorktree, git: Git, checkCurrent?: () => void) {
  const registration = await git(worktree.repository, ["worktree", "list", "--porcelain", "-z"]);
  if (registration.split("\0").some(line =>
    line.startsWith("worktree ") && realFolder(line.slice("worktree ".length)) === realFolder(worktree.path)))
    {
      checkCurrent?.();
      if (checkCurrent && fs.existsSync(worktree.path)) throw Error("The planned Code worktree path is occupied.");
      await git(worktree.repository, ["worktree", "remove", ...(checkCurrent ? [] : ["--force"]), worktree.path]);
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
  discardChanges = false,
): Promise<"deleted" | "kept"> {
  if (!fs.existsSync(worktree.path)) {
    await clearMissingWorktreeRegistration(worktree, git).catch(
      () => undefined,
    );
    return "deleted";
  }
  if (!discardChanges && (await worktreeChanges(worktree, git)) !== 0) return "kept";
  if (!await isRecordedWorktree(worktree, git)) return "kept";
  try {
    await git(worktree.repository, [
      "-c",
      "core.longpaths=true",
      "worktree",
      "remove",
      ...(discardChanges ? ["--force"] : []),
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
  if (await removeSessionWorktree(worktree, git, true) !== "deleted")
    throw Error("The session worktree could not be removed.");
}

/**
 * Brings back an archived session's worktree from its branch (unarchiving):
 * the folder is added again where it was, on the same branch.
 */
export async function restoreSessionWorktree(
  worktree: SessionWorktree,
  git: Git = localGit,
  cwd = worktree.path,
) {
  if (!isInside(worktree.path, cwd))
    throw Error("The session folder is outside its worktree.");
  if (fs.existsSync(worktree.path)) {
    if (!await isRecordedWorktree(worktree, git))
      throw Error("Another folder now occupies the Code worktree path.");
    ensureWorktreeDirectory(worktree.path, cwd);
    return;
  }
  await clearMissingWorktreeRegistration(worktree, git);
  const archivedTip = worktree.archivedBranchTip;
  const restoreBranch = archivedTip && !await git(worktree.repository, [
    "show-ref", "--verify", "--quiet", `refs/heads/${worktree.branch}`,
  ]).then(() => true, () => false);
  fs.mkdirSync(path.dirname(worktree.path), { recursive: true });
  await git(
    worktree.repository,
    [
      "-c",
      "core.longpaths=true",
      "worktree",
      "add",
      ...(restoreBranch ? ["-b", worktree.branch] : []),
      worktree.path,
      restoreBranch ? archivedTip : worktree.branch,
    ],
    10 * 60_000,
  );
  ensureWorktreeDirectory(worktree.path, cwd);
}

export async function restoreSessionFolderWorktree(worktree: SessionFolderWorktree) {
  await restoreSessionWorktree(worktree);
  for (const { cwd } of worktree.folders) ensureWorktreeDirectory(worktree.path, cwd);
}

export async function recoverSessionWorkspace(
  conversation: Pick<Conversation, "cwd" | "worktree" | "additionalFolders" | "additionalWorktrees">,
  {
    present,
    restore,
    restoreAdditional,
    canUseOrigin,
    checkCurrent,
    remoteLabel,
  }: {
    present(tree: SessionWorktree): boolean | Promise<boolean>;
    restore(tree: SessionWorktree, cwd?: string): Promise<string | void>;
    restoreAdditional?(tree: SessionFolderWorktree): Promise<string | void>;
    canUseOrigin(folder: string): boolean | Promise<boolean>;
    checkCurrent(): void;
    remoteLabel?: string;
  },
) {
  let { cwd, worktree, additionalFolders } = conversation;
  const additionalWorktrees: SessionFolderWorktree[] = [];
  const notices: string[] = [];
  const restoredTree = <T extends SessionWorktree>(tree: T, branch: string | void): T => {
    if (remoteLabel) {
      const branchKind = branch ? "a new branch" : "the same branch";
      notices.push(`This session's worktree on \`${noticePath(remoteLabel)}\` had been removed, so it was re-created on ${branchKind}, \`${noticePath(branch || tree.branch)}\`. Uncommitted files weren't carried over.`);
    }
    return branch ? { ...tree, branch } : tree;
  };
  if (worktree && !await present(worktree)) {
    const previous = worktree;
    checkCurrent();
    try {
      const branch = await restore(previous, cwd);
      checkCurrent();
      worktree = restoredTree(previous, branch);
    } catch (error) {
      checkCurrent();
      if (!await canUseOrigin(previous.origin)) throw error;
      cwd = previous.origin;
      notices.push(`This session's old worktree was removed and couldn't be re-created, so it now runs in the main repository at \`${noticePath(cwd)}\` without a worktree of its own. Uncommitted files from the old worktree weren't carried over, and its branch \`${noticePath(previous.branch)}\` may no longer exist.`);
      worktree = undefined;
    }
    checkCurrent();
  }
  for (const tree of conversation.additionalWorktrees ?? []) {
    const attached = await present(tree);
    checkCurrent();
    if (attached) {
      additionalWorktrees.push(tree);
      continue;
    }
    if (restoreAdditional) {
      try {
        const branch = await restoreAdditional(tree);
        checkCurrent();
        additionalWorktrees.push(restoredTree(tree, branch));
        continue;
      } catch {
        checkCurrent();
      }
    }
    for (const { origin, cwd: checkout } of tree.folders) {
      const useOrigin = await canUseOrigin(origin);
      checkCurrent();
      additionalFolders = [...new Set((additionalFolders ?? []).flatMap(folder => {
        if (folder === checkout) return useOrigin ? [origin] : [];
        if (folder === origin && !useOrigin) return [];
        return [folder];
      }))];
      notices.push(useOrigin
        ? `The worktree \`${noticePath(tree.path)}\` for \`${noticePath(origin)}\` was removed, so this session now uses that folder in place. Uncommitted files from the worktree weren't carried over.`
        : `The worktree for \`${noticePath(origin)}\` was removed and the original folder is unavailable.`);
    }
  }
  return notices.length ? {
    cwd, worktree, additionalFolders, additionalWorktrees: additionalWorktrees.length ? additionalWorktrees : undefined,
    notices,
  } : undefined;
}

/**
 * After the pull request merged (auto-archive): the worktree's branch goes
 * too, unless it holds commits that were never pushed (live claude.ai
 * bundle, 2026-10-14: "deletes its branch once the pull request is merged.
 * Work that isn't pushed is kept"). True when it was deleted.
 */
export async function deleteMergedBranch(
  worktree: SessionWorktree,
  git: Git = localGit,
  retainTip?: (tip: string) => boolean,
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
    const tip = (await git(worktree.repository, ["rev-parse", "--verify", `refs/heads/${worktree.branch}`])).trim();
    if (retainTip && !retainTip(tip)) return false;
    await git(worktree.repository, ["branch", "-D", "--", worktree.branch]);
    worktree.archivedBranchTip = tip;
    return true;
  } catch {
    return false;
  }
}
