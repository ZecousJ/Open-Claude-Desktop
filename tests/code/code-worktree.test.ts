import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createSessionWorktree,
  deleteMergedBranch,
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
