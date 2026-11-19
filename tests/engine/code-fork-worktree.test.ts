import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareCodeForkWorktree } from "../../electron/engine/code-fork-worktree";
import { createSessionWorktree } from "../../electron/git/code-worktree";
import type { Conversation } from "../../shared/types";

test("fork worktree starts at the parent HEAD without its dirty files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-tree-test-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  try {
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.test");
    git(repo, "config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, "file"), "base");
    git(repo, "add", "file");
    git(repo, "commit", "-m", "base");
    const source = await createSessionWorktree(repo, {
      location: path.join(root, "trees"),
    });
    fs.writeFileSync(path.join(source.cwd, "file"), "parent commit");
    git(source.cwd, "commit", "-am", "parent");
    const head = git(source.cwd, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(source.cwd, "file"), "dirty parent");
    const parent = {
      cwd: source.cwd,
      worktree: source.worktree,
    } as Conversation;
    const fork = await prepareCodeForkWorktree(
      parent,
      path.join(root, "trees"),
      "claude",
      () => {},
    );
    assert.notEqual(fork.cwd, source.cwd);
    assert.equal(git(fork.cwd, "rev-parse", "HEAD"), head);
    assert.equal(
      fs.readFileSync(path.join(fork.cwd, "file"), "utf8"),
      "parent commit",
    );
    assert.equal(
      fs.readFileSync(path.join(source.cwd, "file"), "utf8"),
      "dirty parent",
    );
    await fork.cleanup();
    assert.equal(fs.existsSync(fork.worktree.path), false);
    const changed = await prepareCodeForkWorktree(
      parent,
      path.join(root, "trees"),
      "claude",
      () => {},
    );
    fs.writeFileSync(path.join(changed.cwd, "file"), "new child work");
    await changed.cleanup();
    assert.equal(
      fs.readFileSync(path.join(changed.cwd, "file"), "utf8"),
      "new child work",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
