import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncWithBaseBranch } from "../../electron/git/sync-base-branch";
import {
  syncBaseRow,
  syncBaseRunningVerb,
} from "../../shared/sync-base-branch";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-base-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "first");
  const wt = path.join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "claude/x", wt);
  return {
    root,
    repo,
    worktree: {
      path: wt,
      branch: "claude/x",
      repository: repo,
      origin: repo,
      name: "x",
    },
  };
}

test("syncing merges the main checkout's branch, then reads up to date", async () => {
  const { root, repo, worktree } = setup();
  try {
    fs.writeFileSync(path.join(repo, "b.txt"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base change");
    assert.deepEqual(await syncWithBaseBranch(worktree), {
      outcome: "merged",
      base: "main",
    });
    assert.ok(fs.existsSync(path.join(worktree.path, "b.txt")));
    assert.deepEqual(await syncWithBaseBranch(worktree), {
      outcome: "up_to_date",
      base: "main",
    });
    assert.deepEqual(await syncWithBaseBranch(worktree, { action: "abort" }), {
      outcome: "nothing_in_progress",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conflicts stay for Claude to resolve, and abort abandons the merge", async () => {
  const { root, repo, worktree } = setup();
  try {
    fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
    git(repo, "commit", "-qam", "base");
    fs.writeFileSync(path.join(worktree.path, "a.txt"), "session\n");
    git(worktree.path, "commit", "-qam", "session");
    assert.deepEqual(await syncWithBaseBranch(worktree), {
      outcome: "conflicts",
      base: "main",
      conflicts: ["a.txt"],
    });
    assert.deepEqual(await syncWithBaseBranch(worktree, { action: "abort" }), {
      outcome: "aborted",
    });
    assert.equal(
      fs.readFileSync(path.join(worktree.path, "a.txt"), "utf8"),
      "session\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("syncing refuses over uncommitted changes", async () => {
  const { root, worktree } = setup();
  try {
    fs.writeFileSync(path.join(worktree.path, "a.txt"), "edited\n");
    await assert.rejects(syncWithBaseBranch(worktree), /uncommitted changes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the row reads the outcome", () => {
  assert.deepEqual(syncBaseRow('{"outcome":"merged","base":"main"}'), {
    verb: "Merged base branch",
    base: "main",
  });
  assert.deepEqual(syncBaseRow('{"outcome":"aborted"}'), {
    verb: "Abandoned merge",
  });
  assert.equal(syncBaseRow("not json"), undefined);
  assert.equal(syncBaseRunningVerb({ abort: true }), "Abandoning merge");
  assert.equal(syncBaseRunningVerb({}), "Merging base branch");
});
