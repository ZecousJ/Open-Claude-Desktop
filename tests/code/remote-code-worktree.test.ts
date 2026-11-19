import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  createSessionWorkspace,
  recoverSessionWorkspace,
  WorktreeError,
} from "../../electron/git/code-worktree";
import {
  createRemoteSessionWorktree,
  ownsRemoteCodeWorktreePath,
  probeRemoteSessionWorktree,
  remoteSessionWorktreeExists,
  remoteSessionWorktreeOperations,
  removeRemoteSessionWorktree,
  restoreRemoteSessionFolderWorktree,
  restoreRemoteSessionWorktree,
} from "../../electron/git/remote-code-worktree";
import {
  connectionRunner,
  RemoteWorkspace,
} from "../../electron/ssh/remote-workspace";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repository(parent: string, name: string) {
  const root = path.join(parent, name);
  fs.mkdirSync(root);
  git(root, "init", "-q", "-b", "main", "--template=");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  for (const folder of ["app", "tools", "private"]) {
    const nested = path.join(root, folder);
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "file"), folder + "\n");
  }
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return root;
}

function fixture(t: TestContext) {
  const folder = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cx-remote-wt-")),
  );
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const run = connectionRunner({
    exec: (script, options) =>
      new Promise((resolve, reject) => {
        execFile(
          "/bin/sh",
          ["-c", script],
          { timeout: options?.timeoutMs, maxBuffer: options?.maxOutput },
          (error, stdout, stderr) => {
            if (error && typeof error.code !== "number") return reject(error);
            resolve({
              code: typeof error?.code === "number" ? error.code : 0,
              stdout,
              stderr,
            });
          },
        );
      }),
  });
  const workspace = new RemoteWorkspace(
    "isolated-host",
    "Isolated host",
    () => run,
  );
  return { folder, run, workspace };
}

test(
  "SSH extra folders share one worktree per repository and preserve folder-specific trust",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const { folder, workspace } = fixture(t);
    const primary = repository(folder, "primary");
    const extra = repository(folder, "extra's repo");
    const primaryExtra = path.join(primary, "tools");
    const app = path.join(extra, "app");
    const tools = path.join(extra, "tools");
    const untrusted = path.join(extra, "private");
    const additionalFolders = [primaryExtra, app, untrusted, tools];
    const made = await createSessionWorkspace({
      cwd: primary,
      primary: {},
      additionalFolders,
      requested: additionalFolders.map((path) => ({ path })),
      isTrusted: (folder) => folder !== untrusted,
      checkCurrent() {},
      options: { location: "/desktop-only-setting", prefix: "test" },
      operations: remoteSessionWorktreeOperations(workspace),
    });
    assert.ok(made.worktree);
    assert.equal(made.additionalWorktrees.length, 1);
    const [tree] = made.additionalWorktrees;
    assert.deepEqual(made.additionalFolders, [
      primaryExtra,
      path.join(tree.path, "app"),
      path.join(tree.path, "tools"),
    ]);
    assert.deepEqual(
      tree.folders.map((folder) => folder.origin),
      [app, tools],
    );
    assert.equal(
      path.dirname(tree.path),
      path.join(extra, ".claude", "worktrees"),
    );
    assert.equal(git(extra, "status", "--porcelain"), "");
    const owner = {
      mode: "code",
      environment: { kind: "ssh", hostId: "isolated-host" },
      worktree: made.worktree,
      additionalWorktrees: [tree],
    } satisfies Parameters<typeof ownsRemoteCodeWorktreePath>[0];
    assert.equal(
      ownsRemoteCodeWorktreePath(owner, tree.folders[1].cwd, owner.environment),
      true,
    );
    assert.ok(
      !ownsRemoteCodeWorktreePath(owner, tree.folders[1].cwd, {
        kind: "ssh",
        hostId: "other",
      }),
    );
    assert.ok(
      !ownsRemoteCodeWorktreePath(owner, tree.folders[1].cwd, {
        kind: "wsl",
        distro: "isolated-host",
      }),
    );
    assert.equal(await removeRemoteSessionWorktree(workspace, tree), "deleted");
    await restoreRemoteSessionFolderWorktree(workspace, tree);
    assert.equal(git(tree.path, "branch", "--show-current"), tree.branch);
    assert.ok(
      tree.folders.every((folder) =>
        fs.existsSync(path.join(folder.cwd, "file")),
      ),
    );
  },
);

test(
  "remote deletion preserves unique commits and refuses to discard a replacement checkout",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const { folder, workspace } = fixture(t);
    const repo = repository(folder, "repository");
    const { worktree: unique } = await createRemoteSessionWorktree(
      workspace,
      repo,
    );
    git(unique.path, "commit", "--allow-empty", "-qm", "unique");
    const commit = git(unique.path, "rev-parse", "HEAD");
    assert.equal(
      await removeRemoteSessionWorktree(workspace, unique, false, true),
      "deleted",
    );
    assert.equal(git(repo, "rev-parse", unique.branch), commit);

    const { worktree: redundant } = await createRemoteSessionWorktree(
      workspace,
      repo,
    );
    assert.equal(
      await removeRemoteSessionWorktree(workspace, redundant, false, true),
      "deleted",
    );
    assert.equal(git(repo, "branch", "--list", redundant.branch), "");

    const { worktree: replaced } = await createRemoteSessionWorktree(
      workspace,
      repo,
    );
    fs.renameSync(replaced.path, path.join(folder, "moved-checkout"));
    repository(path.dirname(replaced.path), path.basename(replaced.path));
    assert.equal(
      (await probeRemoteSessionWorktree(workspace, replaced)).unreadable,
      true,
    );
    assert.equal(
      await removeRemoteSessionWorktree(workspace, replaced, true, true),
      "kept",
    );
    await assert.rejects(
      restoreRemoteSessionWorktree(workspace, replaced),
      /occupied/,
    );
    assert.equal(git(replaced.path, "branch", "--show-current"), "main");

    const { worktree: old } = await createRemoteSessionWorktree(
      workspace,
      repo,
    );
    assert.equal(await removeRemoteSessionWorktree(workspace, old), "deleted");
    const moved = path.join(folder, "replacement-linked-checkout");
    git(repo, "worktree", "add", "-qb", "replacement", "--", moved, "HEAD");
    git(repo, "worktree", "move", "--", moved, old.path);
    assert.equal(
      (await probeRemoteSessionWorktree(workspace, old)).unreadable,
      true,
    );
    assert.equal(
      await removeRemoteSessionWorktree(workspace, old, true, true),
      "kept",
    );
    assert.equal(git(old.path, "branch", "--show-current"), "replacement");
  },
);

test(
  "cancelling a remote checkout removes its worktree and generated branch",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const { folder, run, workspace } = fixture(t);
    const repo = repository(folder, "repository");
    const { worktree: other } = await createRemoteSessionWorktree(
      workspace,
      repo,
    );
    const controller = new AbortController();
    const cancelled = new Error("Stopped");
    const delayed = new RemoteWorkspace(
      "isolated-host",
      "Isolated host",
      () => async (command) => {
        const result = await run(command);
        if (command.argv[0] === "git" && command.argv.includes("add"))
          controller.abort(cancelled);
        return result;
      },
    );
    await assert.rejects(
      createRemoteSessionWorktree(delayed, repo, { signal: controller.signal }),
      cancelled,
    );
    assert.deepEqual(
      git(repo, "branch", "--format=%(refname:short)").split("\n").sort(),
      [other.branch, "main"].sort(),
    );
    assert.deepEqual(fs.readdirSync(path.dirname(other.path)), [other.name]);
  },
);

test(
  "remote recovery keeps an existing branch and replaces a deleted one from its recorded source",
  { skip: process.platform === "win32" },
  async (t) => {
    const { folder, workspace } = fixture(t);
    const repo = repository(folder, "repository");
    git(repo, "switch", "-qc", "selected");
    git(repo, "commit", "--allow-empty", "-qm", "selected source");
    const source = git(repo, "rev-parse", "HEAD");
    git(repo, "switch", "-q", "main");
    const { worktree, cwd } = await createRemoteSessionWorktree(
      workspace,
      path.join(repo, "app"),
      { prefix: "team/sessions", startBranch: "selected" },
    );

    assert.equal(
      await removeRemoteSessionWorktree(workspace, worktree),
      "deleted",
    );
    assert.equal(
      await restoreRemoteSessionWorktree(workspace, worktree, cwd),
      undefined,
    );
    assert.equal(git(cwd, "branch", "--show-current"), worktree.branch);
    assert.equal(
      await removeRemoteSessionWorktree(workspace, worktree),
      "deleted",
    );

    const elsewhere = path.join(folder, "elsewhere");
    git(repo, "worktree", "add", "-q", "--", elsewhere, worktree.branch);
    await assert.rejects(
      restoreRemoteSessionWorktree(workspace, worktree, cwd),
      /already (used|checked out)/,
    );
    assert.equal(git(elsewhere, "branch", "--show-current"), worktree.branch);
    assert.equal(fs.existsSync(worktree.path), false);
    git(repo, "worktree", "remove", "--", elsewhere);
    git(repo, "branch", "-D", "--", worktree.branch);

    const recover = () =>
      recoverSessionWorkspace(
        { cwd, worktree },
        {
          present: (tree) => remoteSessionWorktreeExists(workspace, tree),
          restore: (tree, cwd) =>
            restoreRemoteSessionWorktree(workspace, tree, cwd),
          remoteLabel: workspace.label,
          canUseOrigin: () => false,
          checkCurrent() {},
        },
      );
    const recovered = await recover();
    assert.ok(recovered?.worktree);
    assert.equal(recovered.cwd, cwd);
    assert.equal(recovered.worktree.path, worktree.path);
    assert.equal(recovered.worktree.sourceBranch, "selected");
    assert.match(recovered.worktree.branch, /^team\/sessions\//);
    assert.notEqual(recovered.worktree.branch, worktree.branch);
    assert.equal(
      git(cwd, "branch", "--show-current"),
      recovered.worktree.branch,
    );
    assert.equal(git(cwd, "rev-parse", "HEAD"), source);
    assert.equal(git(repo, "branch", "--list", worktree.branch), "");
    assert.match(recovered.notices[0], /re-created on a new branch/);
    assert.equal(
      (await recover())?.worktree?.branch,
      recovered.worktree.branch,
    );
  },
);

test(
  "a selected branch cannot map a nested worktree folder outside the checkout",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const { folder, workspace } = fixture(t);
    const repo = repository(folder, "repository");
    const outside = path.join(folder, "outside");
    const nested = path.join(repo, "app", "nested");
    fs.mkdirSync(outside);
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "file"), "nested\n");
    git(repo, "add", "app");
    git(repo, "commit", "-qm", "nested");
    git(repo, "switch", "-qc", "selected");
    fs.rmSync(path.join(repo, "app"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(repo, "app"));
    git(repo, "add", "app");
    git(repo, "commit", "-qm", "link");
    git(repo, "switch", "-q", "main");
    await assert.rejects(
      createRemoteSessionWorktree(workspace, nested, {
        startBranch: "selected",
      }),
      (error) => error instanceof WorktreeError && error.code === "failed",
    );
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.deepEqual(
      fs.readdirSync(path.join(repo, ".claude", "worktrees")),
      [],
    );
  },
);
