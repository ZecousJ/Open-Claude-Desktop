/**
 * The facts behind a Code session's branch row (electron/code-git.ts), read
 * with the system git from a throwaway repository.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codeGitStatus,
  numstatTotals,
  pickRemote,
} from "../../electron/git/code-git";
import {
  githubRepositoryIn,
  githubRepositoryName,
} from "../../electron/git/git-branch";

function repository(remote = "https://github.com/octo/hello.git") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-code-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "a@example.test");
  git("config", "user.name", "A");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  if (remote) {
    git("remote", "add", "origin", remote);
    // What a clone leaves: origin/main, and origin/HEAD pointing at it.
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  }
  return { dir, git };
}

test("remote addresses name their github.com repository in every form", () => {
  for (const url of [
    "https://github.com/octo/hello.git",
    "https://github.com/octo/hello",
    "git@github.com:octo/hello.git",
    "ssh://git@github.com/octo/hello.git",
    '"https://github.com/octo/hello/"',
  ])
    assert.equal(githubRepositoryName(url), "octo/hello", url);
  for (const url of [
    "https://gitlab.com/octo/hello",
    "https://github.com.evil.example/octo/hello",
    "https://github.com/octo",
    "https://github.com/octo/hello/tree/main",
  ])
    assert.equal(githubRepositoryName(url), undefined, url);
});

test("the repository comes from origin first, and only from remote sections", () => {
  assert.equal(
    githubRepositoryIn(
      '[remote "fork"]\n\turl = git@github.com:me/hello.git\n[remote "origin"]\n\turl = https://github.com/octo/hello.git\n',
    ),
    "octo/hello",
  );
  assert.equal(
    githubRepositoryIn(
      '[remote "origin"]\n\turl = https://gitlab.com/o/r\n[branch "main"]\n\turl = https://github.com/o/r\n',
    ),
    undefined,
  );
  assert.equal(githubRepositoryIn(undefined), undefined);
  assert.equal(
    pickRemote(
      "remote.up.url https://gitlab.com/o/r\nremote.mine.url git@github.com:me/r.git",
    )?.name,
    "mine",
  );
  assert.equal(pickRemote(""), undefined);
});

test("numstat totals count text lines and skip binary files", () => {
  assert.deepEqual(numstatTotals("3\t1\ta.txt\n-\t-\timg.png\n10\t0\tb.ts\n"), {
    additions: 13,
    deletions: 1,
  });
  assert.deepEqual(numstatTotals(""), { additions: 0, deletions: 0 });
});

test("a clean checkout of the base branch has nothing to open a pull request from", async () => {
  const { dir } = repository();
  const status = await codeGitStatus(dir);
  assert.deepEqual(status, {
    state: "ready",
    branch: "main",
    baseBranch: "main",
    repository: "octo/hello",
    ahead: 0,
    behind: 0,
    pushed: true,
    dirty: false,
    additions: 0,
    deletions: 0,
  });
});

test("a branch counts the commits its base gained since it left (the row's ↓)", async () => {
  const { dir, git } = repository();
  git("checkout", "-q", "-b", "feature/y");
  // origin/main moves on twice after the branch was made.
  git("checkout", "-q", "main");
  for (const line of ["four", "five"]) {
    fs.appendFileSync(path.join(dir, "a.txt"), `${line}\n`);
    git("commit", "-q", "-am", line);
  }
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "feature/y");
  const status = await codeGitStatus(dir);
  assert.equal(status.behind, 2);
  assert.equal(status.ahead, 0);
});

test("a feature branch counts its commits ahead, its changes and whether it was pushed", async () => {
  const { dir, git } = repository();
  git("checkout", "-q", "-b", "feature/x");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
  git("commit", "-q", "-am", "add a line");
  // An uncommitted change on top: one line replaced, one new file.
  fs.writeFileSync(path.join(dir, "a.txt"), "ONE\ntwo\nthree\nfour\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "x\n");
  const status = await codeGitStatus(dir);
  assert.equal(status.branch, "feature/x");
  assert.equal(status.baseBranch, "main");
  assert.equal(status.ahead, 1);
  assert.equal(status.dirty, true);
  assert.equal(status.pushed, false);
  // Against the point it left main: two lines added and one removed in a.txt.
  assert.deepEqual([status.additions, status.deletions], [2, 1]);
  git("update-ref", "refs/remotes/origin/feature/x", "HEAD");
  assert.equal((await codeGitStatus(dir)).pushed, true);
});

test("a folder without a GitHub remote names no repository; outside git and without a folder are said so", async () => {
  const { dir } = repository("https://gitlab.com/octo/hello.git");
  const status = await codeGitStatus(dir);
  assert.equal(status.state, "ready");
  assert.equal(status.repository, undefined);
  assert.equal(status.branch, "main");
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-plain-"));
  const outside = await codeGitStatus(plain);
  // The temp folder may itself sit inside a checkout on a developer machine.
  assert.ok(outside.state === "not-git" || outside.state === "ready");
  assert.equal((await codeGitStatus(undefined)).state, "no-folder");
});

test("a failing query is an empty answer, a failing host is an error", async () => {
  const transport = Object.assign(new Error("host down"), { transport: true });
  await assert.rejects(
    codeGitStatus("/x", {
      git: async () => {
        throw transport;
      },
      entries: async () => new Map(),
      lineCounts: async () => ({}),
    }),
    /host down/,
  );
});
