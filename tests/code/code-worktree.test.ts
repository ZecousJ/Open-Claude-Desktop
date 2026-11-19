import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createSessionWorktree,
  planRemoteCodeWorktree,
  materializeRemoteCodeWorktree,
  cleanupRemoteCodeWorktree,
  isRecordedWorktree,
  deleteMergedBranch,
  localGit,
  removeSessionWorktree,
  restoreSessionWorktree,
  worktreeBranch,
  WorktreeError,
} from "../../electron/git/code-worktree";
import { branchPrefixProblem } from "../../shared/branch-prefix";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repository(commit = true) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-wt-")),
  );
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app", "a.txt"), "a\n");
  if (commit) {
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "first");
  }
  return dir;
}

test("a session's worktree is a new branch beside the repository, kept out of its status", async (t) => {
  const repo = repository();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const { worktree, cwd } = await createSessionWorktree(
    path.join(repo, "app"),
    {
      prefix: "claude",
    },
  );
  assert.equal(worktree.repository, repo);
  assert.equal(
    path.dirname(worktree.path),
    path.join(repo, ".claude", "worktrees"),
  );
  assert.match(worktree.branch, /^claude\/[a-z]+-[a-z]+-[0-9a-f]{6}$/);
  // The session works in the same subfolder inside the worktree.
  assert.equal(cwd, path.join(worktree.path, "app"));
  assert.ok(fs.existsSync(path.join(cwd, "a.txt")));
  assert.equal(
    git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD"),
    worktree.branch,
  );
  assert.equal(git(repo, "status", "--porcelain"), "");

  // Clean: removed on archive, its branch stays; unarchiving brings it back.
  assert.equal(await removeSessionWorktree(worktree), "deleted");
  assert.ok(!fs.existsSync(worktree.path));
  assert.ok(git(repo, "branch", "--list", worktree.branch));
  await restoreSessionWorktree(worktree);
  assert.ok(fs.existsSync(path.join(cwd, "a.txt")));

  // With changes it is kept.
  fs.writeFileSync(path.join(cwd, "b.txt"), "b\n");
  assert.equal(await removeSessionWorktree(worktree), "kept");
  assert.ok(fs.existsSync(worktree.path));
});

test("a custom location holds the worktrees under the repository's name", async (t) => {
  const repo = repository();
  const place = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-wt-place-")),
  );
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(place, { recursive: true, force: true });
  });
  const { worktree } = await createSessionWorktree(repo, {
    location: place,
    prefix: "",
  });
  assert.equal(
    path.dirname(worktree.path),
    path.join(place, path.basename(repo)),
  );
  assert.doesNotMatch(worktree.branch, /\//);
  const sibling = await createSessionWorktree(repo, { location: path.dirname(repo) });
  t.after(() => fs.rmSync(path.dirname(sibling.worktree.path), { recursive: true, force: true }));
  assert.equal(path.dirname(sibling.worktree.path), `${repo}-worktrees`);
});

test("a new worktree follows the selected branch on origin and keeps its own branch", async (t) => {
  const repo = repository();
  const origin = repository();
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(origin, { recursive: true, force: true });
  });
  git(origin, "branch", "-m", "trunk");
  fs.writeFileSync(path.join(origin, "app", "a.txt"), "remote default\n");
  git(origin, "commit", "-qam", "remote default");
  git(repo, "remote", "add", "origin", origin);
  const fromDefault = await createSessionWorktree(repo, { branchHint: "team/Fix Git Switch!" });
  assert.equal(fromDefault.worktree.sourceBranch, "trunk");
  assert.match(fromDefault.worktree.branch, /^claude\/fix-git-switch-[0-9a-f]{6}$/);
  assert.equal(git(fromDefault.cwd, "rev-parse", "HEAD"), git(origin, "rev-parse", "trunk"));
  assert.equal(git(repo, "symbolic-ref", "refs/remotes/origin/HEAD"), "refs/remotes/origin/trunk");

  git(origin, "switch", "-qc", "delivery");
  fs.writeFileSync(path.join(origin, "app", "a.txt"), "selected remote branch\n");
  git(origin, "commit", "-qam", "delivery");
  const selected = await createSessionWorktree(repo, { startBranch: "delivery" });
  assert.equal(selected.worktree.sourceBranch, "delivery");
  assert.equal(git(selected.cwd, "rev-parse", "HEAD"), git(origin, "rev-parse", "delivery"));
  assert.equal(git(selected.cwd, "for-each-ref", "--format=%(upstream:short)", `refs/heads/${selected.worktree.branch}`), "");
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(fs.readFileSync(path.join(repo, "app", "a.txt"), "utf8"), "a\n");

  const missing = await createSessionWorktree(repo, { startBranch: "missing" });
  assert.equal(missing.worktree.sourceBranch, "main");
  assert.equal(git(missing.cwd, "rev-parse", "HEAD"), git(repo, "rev-parse", "main"));
});

test("a selected branch cannot map a local worktree folder outside its checkout", {
  skip: process.platform === "win32",
}, async (t) => {
  const repo = repository();
  const outside = repository();
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  git(repo, "switch", "-qc", "linked");
  fs.rmSync(path.join(repo, "app"), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, "app"));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "link outside the repository");
  git(repo, "switch", "-q", "main");
  await assert.rejects(createSessionWorktree(path.join(repo, "app"), { startBranch: "linked" }), WorktreeError);
  assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
  assert.equal(git(repo, "branch", "--list", "claude/*"), "");
  assert.equal(fs.readFileSync(path.join(outside, "app", "a.txt"), "utf8"), "a\n");
});

test("a worktree needs a repository with a commit", async (t) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-wt-plain-"));
  const empty = repository(false);
  t.after(() => {
    fs.rmSync(plain, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  });
  await assert.rejects(
    createSessionWorktree(plain),
    (error) =>
      error instanceof WorktreeError && error.code === "not-repository",
  );
  await assert.rejects(
    createSessionWorktree(empty),
    (error) => error instanceof WorktreeError && error.code === "no-commits",
  );
});

test("cancelling checkout removes the just-created worktree and branch only", async (t) => {
  const repo = repository();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const { worktree: existing } = await createSessionWorktree(repo);
  const controller = new AbortController();
  const cancelled = new Error("Stopped");
  await assert.rejects(
    createSessionWorktree(repo, {
      signal: controller.signal,
      async git(cwd, args, timeout, signal) {
        const result = await localGit(cwd, args, timeout, signal);
        if (args.includes("add")) {
          assert.equal(signal, controller.signal);
          controller.abort(cancelled);
        }
        return result;
      },
    }),
    cancelled,
  );
  assert.deepEqual(fs.readdirSync(path.dirname(existing.path)), [
    existing.name,
  ]);
  assert.deepEqual(
    git(repo, "branch", "--format=%(refname:short)").split("\n"),
    [existing.branch, "main"],
  );
});

test("branch names and the prefix rule", () => {
  assert.equal(worktreeBranch("claude", "x"), "claude/x");
  assert.equal(worktreeBranch("team/", "x"), "team/x");
  assert.equal(worktreeBranch("", "x"), "x");
  assert.equal(branchPrefixProblem("claude"), null);
  assert.equal(branchPrefixProblem(""), null);
  assert.equal(branchPrefixProblem("main"), "reserved");
  assert.equal(branchPrefixProblem("release-x"), "reserved");
  assert.equal(branchPrefixProblem("a/b"), "format");
  assert.equal(branchPrefixProblem("a..b"), "format");
  assert.equal(branchPrefixProblem("x.lock"), "format");
});

test("after a merge the worktree's branch goes only when everything on it was pushed", async (t) => {
  const repo = repository();
  const remote = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-wt-remote-")),
  );
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  });
  git(remote, "init", "-q", "--bare");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  const { worktree, cwd } = await createSessionWorktree(repo);
  fs.writeFileSync(path.join(cwd, "b.txt"), "b\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "work");
  assert.equal(await removeSessionWorktree(worktree), "deleted");
  // Not pushed: kept.
  assert.equal(await deleteMergedBranch(worktree), false);
  assert.ok(git(repo, "branch", "--list", worktree.branch));
  // Pushed: deleted.
  git(repo, "push", "-q", "origin", worktree.branch);
  assert.equal(await deleteMergedBranch(worktree), true);
  assert.equal(git(repo, "branch", "--list", worktree.branch), "");
});


test("remote worktree plan survives a restart and rejects an occupied path", async (t) => {
  const repo = repository();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const plan = await planRemoteCodeWorktree(path.join(repo, "app"), "", "claude");
  assert.equal(fs.existsSync(plan.path), false);
  const first = await materializeRemoteCodeWorktree(plan, () => {});
  const resumed = await materializeRemoteCodeWorktree(JSON.parse(JSON.stringify(plan)), () => {});
  assert.equal(first.cwd, resumed.cwd);
  assert.equal(git(repo, "worktree", "list", "--porcelain").split("worktree ").length - 1, 2);
  await cleanupRemoteCodeWorktree(plan);
  fs.mkdirSync(plan.path, { recursive: true });
  fs.writeFileSync(path.join(plan.path, "keep"), "mine");
  await assert.rejects(materializeRemoteCodeWorktree(plan, () => {}), /occupies/);
  await cleanupRemoteCodeWorktree(plan);
  assert.equal(fs.readFileSync(path.join(plan.path, "keep"), "utf8"), "mine");
});


test("a copied gitdir marker does not make an unregistered folder a session worktree", async (t) => {
  const repo = repository();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const plan = await planRemoteCodeWorktree(path.join(repo, "app"), "", "claude");
  await materializeRemoteCodeWorktree(plan, () => {});
  const copy = path.join(repo, "impostor");
  fs.mkdirSync(copy);
  fs.copyFileSync(path.join(plan.path, ".git"), path.join(copy, ".git"));
  assert.equal(await isRecordedWorktree({ ...plan, path: copy }), false);
  assert.equal(await isRecordedWorktree(plan), true);
});


test("remote cleanup preserves a worktree with user changes", async (t) => {
  const repo = repository();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const plan = await planRemoteCodeWorktree(path.join(repo, "app"), "", "claude");
  await materializeRemoteCodeWorktree(plan, () => {});
  fs.writeFileSync(path.join(plan.path, "new-file"), "keep");
  await cleanupRemoteCodeWorktree(plan);
  assert.equal(fs.readFileSync(path.join(plan.path, "new-file"), "utf8"), "keep");
  assert.equal(await isRecordedWorktree(plan), true);
});
