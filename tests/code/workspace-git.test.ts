import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  branchFromHead,
  githubUrl,
  hasGithubRemote,
  workspaceGit,
} from "../../electron/git/git-branch";

function repository(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-git-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

test("The branch comes from HEAD; a detached HEAD shows its short commit", () => {
  assert.equal(branchFromHead("ref: refs/heads/main\n"), "main");
  assert.equal(branchFromHead("ref: refs/heads/feature/x\n"), "feature/x");
  assert.equal(
    branchFromHead("0123456789abcdef0123456789abcdef01234567\n"),
    "0123456",
  );
  assert.equal(branchFromHead("garbage"), null);
  assert.equal(branchFromHead(undefined), null);
});

test("GitHub remotes are recognized in every URL form, and only in remote sections", () => {
  assert.ok(githubUrl("https://github.com/owner/repo.git"));
  assert.ok(githubUrl("git@github.com:owner/repo.git"));
  assert.ok(githubUrl("ssh://git@github.com/owner/repo"));
  assert.ok(!githubUrl("https://gitlab.com/owner/repo"));
  assert.ok(!githubUrl("https://github.com.evil.example/owner/repo"));
  assert.ok(!githubUrl("git@notgithub.com:owner/repo"));
  assert.ok(
    hasGithubRemote(
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:o/r.git\n',
    ),
  );
  assert.ok(
    !hasGithubRemote(
      '[remote "origin"]\n\turl = https://gitlab.com/o/r\n[branch "main"]\n\turl = https://github.com/o/r\n',
    ),
  );
});

test("A folder inside a repository reads its branch and remotes from files only", () => {
  const root = repository({
    ".git/HEAD": "ref: refs/heads/main\n",
    // Configuration that would run a program if git were invoked.
    ".git/config":
      '[core]\n\tfsmonitor = touch ran-fsmonitor\n[remote "origin"]\n\turl = https://github.com/o/r.git\n',
    "src/index.ts": "",
  });
  assert.deepEqual(workspaceGit(path.join(root, "src")), {
    branch: "main",
    githubRemote: true,
  });
  assert.ok(!fs.existsSync(path.join(root, "src", "ran-fsmonitor")));
  assert.ok(!fs.existsSync(path.join(root, "ran-fsmonitor")));
});

test("A linked worktree reads HEAD from its own git directory and remotes from the common one", () => {
  const main = repository({
    ".git/HEAD": "ref: refs/heads/main\n",
    ".git/config": '[remote "origin"]\n\turl = https://gitlab.com/o/r\n',
    ".git/worktrees/topic/HEAD": "ref: refs/heads/topic\n",
    ".git/worktrees/topic/commondir": "../..\n",
  });
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-worktree-"));
  fs.writeFileSync(
    path.join(tree, ".git"),
    `gitdir: ${path.join(main, ".git", "worktrees", "topic")}\n`,
  );
  assert.deepEqual(workspaceGit(tree), {
    branch: "topic",
    githubRemote: false,
  });
});

test("Outside a repository there is no branch", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-plain-"));
  const result = workspaceGit(folder);
  // The temp folder may itself sit inside a checkout on a developer machine.
  if (result.branch === null) assert.equal(result.githubRemote, false);
});
