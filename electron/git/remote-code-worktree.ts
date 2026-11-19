import { randomBytes } from "node:crypto";
import { posix as path } from "node:path";
import type {
  Conversation,
  EnvironmentRef,
  SessionFolderWorktree,
  SessionWorktree,
} from "../../shared/types";
import { sameEnvironment } from "../engine/engine-types";
import {
  checkHostPath,
  remoteWorkspace,
  type RemoteResult,
  type RemoteSources,
  type RemoteWorkspace,
} from "../ssh/remote-workspace";
import { wslWorkspace } from "../wsl/wsl";
import {
  resolveWorktreeSource,
  worktreeBranch,
  WorktreeError,
  worktreeName,
  type SessionWorktreeOperations,
  type SessionWorktreeProbe,
} from "./code-worktree";

const probeTimeout = 4_000;
const statusOutputLimit = 4 * 1024 * 1024;
const checkoutTimeout = 10 * 60_000;

type RemoteEnvironment = Extract<EnvironmentRef, { kind: "ssh" | "wsl" }>;

export function remoteWorktreeWorkspaceFor(
  sources: RemoteSources,
  environment: RemoteEnvironment,
): RemoteWorkspace {
  return environment.kind === "wsl"
    ? wslWorkspace(environment.distro)
    : remoteWorkspace(sources, environment.hostId);
}

export function ownsRemoteCodeWorktreePath(
  conversation: Pick<
    Conversation,
    | "mode"
    | "environment"
    | "cloudHosted"
    | "cloudEnvironmentId"
    | "worktree"
    | "additionalWorktrees"
  >,
  folder: string,
  environment: RemoteEnvironment,
) {
  return (
    conversation.mode === "code" &&
    sameEnvironment(conversation.environment, environment) &&
    !conversation.cloudHosted &&
    !conversation.cloudEnvironmentId &&
    ((conversation.worktree?.state !== "deleted" &&
      conversation.worktree?.path === folder) ||
      conversation.additionalWorktrees?.some(
        (tree) =>
          tree.state !== "deleted" &&
          (tree.path === folder ||
            tree.folders.some((entry) => entry.cwd === folder)),
      ))
  );
}

function runShell(
  workspace: RemoteWorkspace,
  script: string,
  ...args: string[]
) {
  return workspace.run({ argv: ["/bin/sh", "-c", script, "sh", ...args] });
}

function commandOutput(result: RemoteResult) {
  if (result.code === 0) return result.stdout;
  throw new Error(result.stderr.trim() || "The workspace command failed.");
}

async function remoteRepository(
  workspace: RemoteWorkspace,
  folder: string,
  timeoutMs: number,
) {
  const result = await workspace.gitCommand(
    folder,
    [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
      "--show-toplevel",
      "--show-prefix",
    ],
    { timeoutMs },
  );
  if (result.code === 127)
    throw new WorktreeError("Git is required to use a worktree.", "no-git");
  if (result.code === 125 || result.code === 128)
    throw new WorktreeError(
      "Start with worktree needs a Git repository.",
      "not-repository",
    );
  const [directory, common, top, prefix] = commandOutput(result).split("\n");
  const root = checkHostPath(top);
  return {
    key: checkHostPath(common),
    directory: checkHostPath(directory),
    root,
    folder: path.join(root, prefix ?? ""),
  };
}

function isInside(root: string, folder: string) {
  const relative = path.relative(root, folder);
  return relative !== ".." && !relative.startsWith("../");
}

async function makeWorktreeDirectory(
  workspace: RemoteWorkspace,
  root: string,
  folder: string,
) {
  if (!isInside(root, folder))
    throw new Error("The session folder is outside its worktree.");
  if (folder === root) return;
  commandOutput(
    await runShell(
      workspace,
      [
        'root=$(cd -- "$1" && pwd -P) || exit 1',
        "existing=$2",
        'while [ ! -e "$existing" ] && [ ! -L "$existing" ]; do existing=$(dirname -- "$existing"); done',
        'parent=$(cd -- "$existing" && pwd -P) || exit 1',
        'case "$parent/" in "$root/"*) mkdir -p -- "$2" ;; *) exit 1 ;; esac',
      ].join("\n"),
      checkHostPath(root),
      checkHostPath(folder),
    ),
  );
}

async function makeWorktreeFolder(
  workspace: RemoteWorkspace,
  worktree: SessionWorktree,
  folder: string,
  repository = worktree.repository,
) {
  if (!isInside(repository, folder))
    throw new Error("The folder is outside the worktree's repository.");
  const cwd = path.join(worktree.path, path.relative(repository, folder));
  await makeWorktreeDirectory(workspace, worktree.path, cwd);
  return cwd;
}

async function pathExists(workspace: RemoteWorkspace, ...folders: string[]) {
  const result = await runShell(
    workspace,
    'for p do [ ! -e "$p" ] && [ ! -L "$p" ] || exit 0; done; exit 1',
    ...folders.map(checkHostPath),
  );
  if (result.code === 1) return false;
  commandOutput(result);
  return true;
}

async function prepareWorktreeParent(
  workspace: RemoteWorkspace,
  parent: string,
) {
  commandOutput(
    await runShell(
      workspace,
      '[ ! -L "$1" ] && [ ! -L "$2" ] && mkdir -p -- "$2"',
      path.dirname(parent),
      parent,
    ),
  );
}

async function excludeWorktrees(workspace: RemoteWorkspace, root: string) {
  const output = await workspace.git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  const exclude = checkHostPath(output.replace(/\n$/, ""));
  await runShell(
    workspace,
    `if ! grep -Eq '^/?\\.claude/worktrees/?$' "$1" 2>/dev/null; then mkdir -p -- "$(dirname -- "$1")" && printf '\\n/.claude/worktrees/\\n' >> "$1"; fi`,
    exclude,
  );
}

export async function createRemoteSessionWorktree(
  workspace: RemoteWorkspace,
  folder: string,
  {
    prefix = "claude",
    startBranch,
    branchHint,
    signal,
  }: {
    prefix?: string;
    startBranch?: string;
    branchHint?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{ worktree: SessionWorktree; cwd: string }> {
  signal?.throwIfAborted();
  const {
    key,
    root,
    folder: resolvedFolder,
  } = await remoteRepository(workspace, folder, probeTimeout);
  signal?.throwIfAborted();
  if (root.includes("/.claude/worktrees/"))
    throw new WorktreeError(
      "Start from the original repository instead of a managed worktree.",
      "failed",
    );
  const selected = startBranch
    ? await resolveWorktreeSource(startBranch, (args) =>
        workspace.git(root, args),
      )
    : undefined;
  let commit = selected?.commit;
  if (!commit) {
    const head = await workspace.gitCommand(root, [
      "rev-parse",
      "--verify",
      "-q",
      "HEAD",
    ]);
    if (head.code === 1)
      throw new WorktreeError(
        "This repository has no commits yet, so a worktree can't start from it. Make a first commit, or turn off Worktree.",
        "no-commits",
      );
    commit = commandOutput(head).trim();
  }
  const parent = path.join(root, ".claude", "worktrees");
  let name = worktreeName(branchHint);
  while (
    await pathExists(
      workspace,
      path.join(parent, name),
      path.join(key, "worktrees", name),
    )
  )
    name = worktreeName(branchHint);
  const worktree = {
    path: path.join(parent, name),
    branch: worktreeBranch(prefix, name),
    repository: root,
    origin: path.resolve(folder),
    name,
    ...(selected ? { sourceBranch: selected.sourceBranch } : {}),
  };
  try {
    signal?.throwIfAborted();
    await prepareWorktreeParent(workspace, parent);
    await excludeWorktrees(workspace, root).catch(() => {});
    signal?.throwIfAborted();
    const added = await workspace.gitCommand(
      root,
      ["worktree", "add", "-b", worktree.branch, "--", worktree.path, commit],
      { timeoutMs: checkoutTimeout },
    );
    commandOutput(added);
    signal?.throwIfAborted();
    const cwd = await makeWorktreeFolder(workspace, worktree, resolvedFolder);
    signal?.throwIfAborted();
    return { worktree, cwd };
  } catch (error) {
    await cleanupCancelledRemoteSessionWorktree(workspace, worktree).catch(
      () => {},
    );
    signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    throw new WorktreeError(
      /No space left|ENOSPC/i.test(message)
        ? "Free up disk space to set up a worktree, then try again."
        : "Couldn’t create a worktree in this repository.",
      "failed",
    );
  }
}

type LeaseStatus =
  | { kind: "missing"; registered: boolean }
  | { kind: "owned"; branch?: string }
  | { kind: "occupied" };

async function leaseStatus(
  workspace: RemoteWorkspace,
  worktree: SessionWorktree,
): Promise<LeaseStatus> {
  const parent = path.join(
    checkHostPath(worktree.repository),
    ".claude",
    "worktrees",
  );
  if (
    path.dirname(worktree.path) !== parent ||
    path.basename(worktree.path) !== worktree.name
  )
    return { kind: "occupied" };
  const result = await workspace.gitCommand(
    worktree.repository,
    ["worktree", "list", "--porcelain"],
    { timeoutMs: probeTimeout },
  );
  const [main, ...linked] = commandOutput(result).split("\n\n");
  const pathLine = `worktree ${checkHostPath(worktree.path)}`;
  if (main?.split("\n")[0] === pathLine) return { kind: "occupied" };
  const entry = linked.find((record) => record.split("\n")[0] === pathLine);
  if (!(await pathExists(workspace, worktree.path)))
    return { kind: "missing", registered: !!entry };
  if (!entry) return { kind: "occupied" };
  const [repository, checkout] = await Promise.all([
    remoteRepository(workspace, worktree.repository, probeTimeout),
    remoteRepository(workspace, worktree.path, probeTimeout),
  ]);
  if (
    checkout.key !== repository.key ||
    checkout.root !== worktree.path ||
    checkout.directory !== path.join(repository.key, "worktrees", worktree.name)
  )
    return { kind: "occupied" };
  const prefix = "branch refs/heads/";
  const branch = entry
    .split("\n")
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length);
  return { kind: "owned", branch };
}

export async function cleanupCancelledRemoteSessionWorktree(
  workspace: RemoteWorkspace,
  worktree: SessionWorktree,
) {
  const status = await leaseStatus(workspace, worktree);
  if (status.kind !== "owned" || status.branch !== worktree.branch) return;
  await removeRemoteLease(workspace, worktree, status, true);
  await deleteBranchWithoutUniqueCommits(workspace, worktree);
}

export async function remoteSessionWorktreeExists(
  workspace: RemoteWorkspace,
  worktree: SessionWorktree,
) {
  const status = await leaseStatus(workspace, worktree);
  if (status.kind === "occupied")
    throw new Error(
      "The worktree path is occupied by another checkout or folder.",
    );
  return (
    status.kind === "owned" &&
    !(await pendingReplacementBranch(workspace, worktree, status.branch))
  );
}

export async function probeRemoteSessionWorktree(
  workspace: RemoteWorkspace,
  worktree: SessionWorktree,
  primary = true,
): Promise<SessionWorktreeProbe> {
  const folder: Pick<
    SessionWorktreeProbe,
    "folder" | "worktreePath" | "primary"
  > = {
    folder: worktree.origin,
    worktreePath: worktree.path,
    ...(primary ? { primary: true } : {}),
  };
  try {
    if ((await leaseStatus(workspace, worktree)).kind !== "owned")
      return { ...folder, unreadable: true };
    const status = commandOutput(
      await workspace.gitCommand(
        worktree.path,
        [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ],
        { timeoutMs: probeTimeout, maxOutput: statusOutputLimit + 1 },
      ),
    );
    if (Buffer.byteLength(status) > statusOutputLimit)
      return { ...folder, unreadable: true };
    return { ...folder, changes: status.split("\n").filter(Boolean) };
  } catch {
    return { ...folder, unreadable: true };
  }
}

async function removeRemoteLease(
  workspace: RemoteWorkspace,
  worktree: SessionWorktree,
  status: LeaseStatus,
  discardChanges: boolean,
) {
  if (status.kind === "occupied")
    throw new Error(
      "The worktree path is occupied by another checkout or folder.",
    );
  if (status.kind === "missing" && !status.registered) return;
  await workspace.git(worktree.repository, [
    "worktree",
    "remove",
    ...(discardChanges || status.kind === "missing" ? ["--force"] : []),
    "--",
    worktree.path,
  ]);
}

export async function removeRemoteSessionWorktree(
  workspace: RemoteWorkspace,
  worktree: SessionWorktree,
  discardChanges = false,
  deleteBranch = false,
): Promise<"deleted" | "kept"> {
  try {
    const status = await leaseStatus(workspace, worktree);
    await removeRemoteLease(workspace, worktree, status, discardChanges);
    if (
      deleteBranch &&
      status.kind === "owned" &&
      status.branch === worktree.branch
    )
      await deleteBranchWithoutUniqueCommits(workspace, worktree).catch(
        () => {},
      );
    return "deleted";
  } catch {
    return "kept";
  }
}

async function recordedBranchMissing(
  workspace: RemoteWorkspace,
  worktree: SessionWorktree,
) {
  const result = await workspace.gitCommand(
    worktree.repository,
    ["show-ref", "--verify", "--quiet", `refs/heads/${worktree.branch}`],
    { timeoutMs: probeTimeout },
  );
  if (result.code === 1) return true;
  commandOutput(result);
  return false;
}

function replacementBranchPrefix(worktree: SessionWorktree) {
  const prefix = worktree.branch.slice(0, worktree.branch.lastIndexOf("/") + 1);
  return `${prefix}${worktree.name}-`;
}

async function pendingReplacementBranch(
  workspace: RemoteWorkspace,
  worktree: SessionWorktree,
  branch?: string,
) {
  const prefix = replacementBranchPrefix(worktree);
  if (
    branch &&
    branch !== worktree.branch &&
    branch.startsWith(prefix) &&
    /^[0-9a-f]{6}$/.test(branch.slice(prefix.length)) &&
    (await recordedBranchMissing(workspace, worktree))
  )
    return branch;
}

async function restoreRemoteWorktree(
  workspace: RemoteWorkspace,
  worktree: SessionWorktree,
  folders: string[],
) {
  if (folders.some((folder) => !isInside(worktree.path, folder)))
    throw new Error("The session folder is outside its worktree.");
  const status = await leaseStatus(workspace, worktree);
  let replacement: string | undefined;
  let created = false;
  try {
    if (status.kind === "owned") {
      replacement = await pendingReplacementBranch(
        workspace,
        worktree,
        status.branch,
      );
    } else {
      await removeRemoteLease(workspace, worktree, status, false);
      const { key } = await remoteRepository(
        workspace,
        worktree.repository,
        probeTimeout,
      );
      if (
        await pathExists(workspace, path.join(key, "worktrees", worktree.name))
      )
        throw new Error("Another worktree is using this checkout's name.");
      let start = worktree.branch;
      if (await recordedBranchMissing(workspace, worktree)) {
        const source =
          worktree.sourceBranch &&
          (await resolveWorktreeSource(worktree.sourceBranch, (args) =>
            workspace.git(worktree.repository, args),
          ));
        if (!source)
          throw new Error(
            "The worktree branch and its source branch are no longer available.",
          );
        start = source.commit;
        replacement = `${replacementBranchPrefix(worktree)}${randomBytes(3).toString("hex")}`;
      }
      await prepareWorktreeParent(workspace, path.dirname(worktree.path));
      created = true;
      commandOutput(
        await workspace.gitCommand(
          worktree.repository,
          [
            "worktree",
            "add",
            ...(replacement ? ["-b", replacement] : []),
            "--",
            worktree.path,
            start,
          ],
          { timeoutMs: checkoutTimeout },
        ),
      );
    }
    for (const folder of folders)
      await makeWorktreeDirectory(workspace, worktree.path, folder);
    return replacement;
  } catch (error) {
    if (created && replacement)
      await cleanupCancelledRemoteSessionWorktree(workspace, {
        ...worktree,
        branch: replacement,
      }).catch(() => {});
    throw error;
  }
}

export function restoreRemoteSessionWorktree(
  workspace: RemoteWorkspace,
  worktree: SessionWorktree,
  cwd?: string,
) {
  return restoreRemoteWorktree(workspace, worktree, cwd ? [cwd] : []);
}

export function restoreRemoteSessionFolderWorktree(
  workspace: RemoteWorkspace,
  worktree: SessionFolderWorktree,
) {
  return restoreRemoteWorktree(
    workspace,
    worktree,
    worktree.folders.map((folder) => folder.cwd),
  );
}

async function deleteBranchWithoutUniqueCommits(
  workspace: RemoteWorkspace,
  worktree: SessionWorktree,
) {
  const ref = `refs/heads/${worktree.branch}`;
  const unique = await workspace.git(worktree.repository, [
    "rev-list",
    "--count",
    ref,
    "--not",
    `--exclude=${ref}`,
    "--all",
  ]);
  if (unique.trim() === "0")
    await workspace.git(worktree.repository, [
      "branch",
      "-D",
      "--",
      worktree.branch,
    ]);
}

export function remoteSessionWorktreeOperations(
  workspace: RemoteWorkspace,
): SessionWorktreeOperations {
  return {
    kind: "remote",
    create: (folder, options) =>
      createRemoteSessionWorktree(workspace, folder, options),
    async repositoryOf(folder, signal) {
      const result = await remoteRepository(
        workspace,
        folder,
        probeTimeout,
      ).catch(() => undefined);
      signal?.throwIfAborted();
      return result;
    },
    async mapFolder(worktree, folder, repository) {
      const result = await remoteRepository(workspace, folder, probeTimeout);
      return makeWorktreeFolder(workspace, worktree, result.folder, repository);
    },
    cleanupCancelled: (worktree) =>
      cleanupCancelledRemoteSessionWorktree(workspace, worktree),
    isInside,
  };
}
