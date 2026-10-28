import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  folderBranches,
  folderChanges,
  checkBranchSwitchConflict,
  branchPathsOverlap,
  resolveFolderChanges,
  switchFolderBranch,
} from "../../electron/git/folder-branch";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repository() {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-br-")),
  );
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  git(dir, "branch", "other");
  return dir;
}

test("switching branch in a folder asks first about uncommitted changes", async (t) => {
  const repo = repository();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const listed = await folderBranches(repo);
  assert.equal(listed?.current, "main");
  assert.deepEqual([...(listed?.branches ?? [])].sort(), ["main", "other"]);
  assert.equal(listed?.defaultBranch, "main");

  git(repo, "checkout", "-q", "other");
  fs.writeFileSync(path.join(repo, "a.txt"), "other branch\n");
  git(repo, "commit", "-am", "other", "-q");
  git(repo, "checkout", "-q", "main");

  fs.writeFileSync(path.join(repo, "a.txt"), "a\nb\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "n\n");
  assert.deepEqual(await folderChanges(repo), {
    files: 2,
    additions: 1,
    deletions: 0,
  });
  assert.deepEqual(await switchFolderBranch(repo, "other"), {
    ok: false,
    reason: "dirty",
  });

  // Stash keeps the changes (untracked too) and clears the folder.
  assert.equal(await resolveFolderChanges(repo, "stash"), true);
  assert.equal((await folderChanges(repo))?.files, 0);
  assert.match(git(repo, "stash", "list"), /claudex: pre-switch from main/);
  assert.deepEqual(await switchFolderBranch(repo, "other"), { ok: true });
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "other");

  // Commit as WIP, then discard.
  fs.writeFileSync(path.join(repo, "w.txt"), "w\n");
  assert.equal(await resolveFolderChanges(repo, "commit"), true);
  assert.equal(git(repo, "log", "-1", "--format=%s"), "WIP");
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
  assert.equal(await resolveFolderChanges(repo, "discard"), true);
  assert.equal((await folderChanges(repo))?.files, 0);
  assert.ok(!fs.existsSync(path.join(repo, "x.txt")));

  assert.deepEqual(await switchFolderBranch(repo, "missing"), {
    ok: false,
    reason: "failed",
  });

  // A branch checked out in another worktree.
  const other = `${repo}-main`;
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  git(repo, "worktree", "add", "-q", other, "main");
  assert.deepEqual(await switchFolderBranch(repo, "main"), {
    ok: false,
    reason: "elsewhere",
  });
});

test("a folder outside a repository has no branches", async (t) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-br-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.equal(await folderBranches(plain), null);
});

test("branch switches carry unrelated dirty files and gate only overlapping or unmerged paths", async (context) => {
  const repo = repository();
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, "checkout", "-q", "other");
  fs.writeFileSync(path.join(repo, "b.txt"), "target\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "target file");
  git(repo, "checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n");
  assert.equal(await checkBranchSwitchConflict(repo, "other"), false);
  assert.deepEqual(await switchFolderBranch(repo, "other"), { ok: true });
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "dirty\n");
  git(repo, "checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "b.txt"), "untracked collision\n");
  assert.equal(await checkBranchSwitchConflict(repo, "other"), true);
  assert.equal(await checkBranchSwitchConflict(repo, "--help"), true);
  assert.equal(branchPathsOverlap(["directory/"], ["directory/file"]), true);
  assert.equal(branchPathsOverlap(["directory/file"], ["directory"]), true);
  assert.equal(branchPathsOverlap(["a"], ["ab"]), false);
});
