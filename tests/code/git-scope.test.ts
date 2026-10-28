/**
 * The Changes panel's diff scope: what "All changes", "Uncommitted changes",
 * "Compare against" and "Commits" read (electron/working-tree.ts,
 * electron/git-scope.ts) and the menu they make (src/changes/diff-scope.ts),
 * with the system git on throwaway repositories.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  workingTreeChanges,
  localWorkingTree,
} from "../../electron/git/working-tree";
import {
  branchChoices,
  listBranches,
  parseCommits,
  validBranchName,
  validCommitId,
} from "../../electron/git/git-scope";
import { parseUnifiedDiff } from "../../src/diff/diff-model";
import {
  rememberedScope,
  rememberScope,
  scopeEntries,
  scopeText,
} from "../../src/changes/diff-scope";
import { behindLabel, branchUrl } from "../../src/pr/BranchChip";
import type { MenuEntry } from "../../src/ui/Menu";
import type { WorkingTreeChanges } from "../../shared/types";

const made: string[] = [];
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** main with one commit, a clone's origin/main, then feature/x with two commits and an edit. */
function repository() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-scope-"));
  made.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "a@example.test");
  git("config", "user.name", "A");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  git("remote", "add", "origin", "https://github.com/octo/hello.git");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git("checkout", "-q", "-b", "feature/x");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  git("add", ".");
  git("commit", "-q", "-m", "add b");
  fs.writeFileSync(path.join(dir, "c.txt"), "c\n");
  git("add", ".");
  git("commit", "-q", "-m", "add c");
  // Uncommitted on top: one line changed, one new file.
  fs.writeFileSync(path.join(dir, "a.txt"), "ONE\ntwo\nthree\n");
  fs.writeFileSync(path.join(dir, "d.txt"), "d\n");
  return { dir, git };
}

const paths = (changes: WorkingTreeChanges) =>
  parseUnifiedDiff(changes.diff).map((file) => file.path);

test("All changes is the branch since it left its base, uncommitted work included", async () => {
  const { dir } = repository();
  const changes = await workingTreeChanges(dir);
  assert.equal(changes.state, "ready");
  assert.equal(changes.scope, "branch");
  assert.equal(changes.base, "main");
  assert.equal(changes.defaultBase, "main");
  assert.equal(changes.branch, "feature/x");
  assert.equal(changes.dirty, true);
  assert.equal(changes.baseUnknown, undefined);
  assert.deepEqual(paths(changes).sort(), ["a.txt", "b.txt", "c.txt", "d.txt"]);
  assert.deepEqual(
    changes.commits?.map((commit) => commit.subject),
    ["add c", "add b"],
  );
  assert.match(changes.commits?.[0].shortSha ?? "", /^[0-9a-f]{7,}$/);
});

test("Uncommitted changes leaves the branch's commits out", async () => {
  const { dir } = repository();
  const changes = await workingTreeChanges(dir, 3, localWorkingTree, {
    kind: "uncommitted",
  });
  assert.equal(changes.scope, "uncommitted");
  assert.equal(changes.base, "feature/x");
  assert.deepEqual(paths(changes).sort(), ["a.txt", "d.txt"]);
  // The commit list still comes with it, for the menu.
  assert.equal(changes.commits?.length, 2);
});

test("a commit shows only what it changed; an unknown one falls back to All changes", async () => {
  const { dir, git } = repository();
  const sha = git("rev-parse", "HEAD~1").trim();
  const changes = await workingTreeChanges(dir, 3, localWorkingTree, {
    kind: "commit",
    sha,
  });
  assert.equal(changes.scope, "commit");
  assert.equal(changes.head, sha.slice(0, 7));
  assert.deepEqual(paths(changes), ["b.txt"]);
  assert.deepEqual(changes.lineCounts, {});
  const gone = await workingTreeChanges(dir, 3, localWorkingTree, {
    kind: "commit",
    sha: "0".repeat(40),
  });
  assert.equal(gone.scope, "branch");
});

test("Compare against measures from another branch, and its commits follow", async () => {
  const { dir, git } = repository();
  // release/1 sits at feature/x's first commit.
  git("branch", "release/1", "HEAD~1");
  const changes = await workingTreeChanges(dir, 3, localWorkingTree, {
    kind: "branch",
    base: "release/1",
  });
  assert.equal(changes.base, "release/1");
  assert.equal(changes.defaultBase, "main");
  assert.deepEqual(paths(changes).sort(), ["a.txt", "c.txt", "d.txt"]);
  assert.deepEqual(
    changes.commits?.map((commit) => commit.subject),
    ["add c"],
  );
  // A name git would read as an option is ignored: the default stays.
  const odd = await workingTreeChanges(dir, 3, localWorkingTree, {
    kind: "branch",
    base: "--output=x",
  });
  assert.equal(odd.base, "main");
  assert.equal(fs.existsSync(path.join(dir, "x")), false);
});

test("a base with no common commit says so and shows only uncommitted changes", async () => {
  const { dir, git } = repository();
  // A root commit of its own (the empty tree), as an unrelated history.
  const alone = git(
    "commit-tree",
    "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    "-m",
    "alone",
  ).trim();
  git("branch", "island", alone);
  const changes = await workingTreeChanges(dir, 3, localWorkingTree, {
    kind: "branch",
    base: "island",
  });
  assert.equal(changes.baseUnknown, true);
  assert.deepEqual(changes.commits, []);
  assert.deepEqual(paths(changes).sort(), ["a.txt", "d.txt"]);
});

test("the branch list puts the default first and leaves the checked-out branch out", async () => {
  const { dir, git } = repository();
  git("branch", "zeta");
  git("update-ref", "refs/remotes/origin/alpha", "HEAD");
  assert.deepEqual(await listBranches(localWorkingTree.git, dir), [
    "main",
    "alpha",
    "zeta",
  ]);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-plain-"));
  made.push(plain);
  const outside = await listBranches(localWorkingTree.git, plain);
  assert.ok(Array.isArray(outside));
  assert.deepEqual(branchChoices(["b", "a", "main", "a"], "main", "b"), [
    "main",
    "a",
  ]);
});

test("names and ids from the panel are checked before git sees them", () => {
  for (const name of ["main", "feature/x", "release-1.2", "v_2"])
    assert.ok(validBranchName(name), name);
  for (const name of ["-x", "--all", "a..b", "a/", "x.lock", "a//b", "", 3])
    assert.equal(validBranchName(name), false, String(name));
  assert.ok(validCommitId("abc1234"));
  assert.equal(validCommitId("HEAD~1"), false);
  assert.deepEqual(
    parseCommits(
      `${"a".repeat(40)}\0aaaaaaa\0Ada\x001760000000\0Fix it\x1e\n${"b".repeat(40)}\0bbbbbbb\0\0\0\x1e`,
    ),
    [
      {
        sha: "a".repeat(40),
        shortSha: "aaaaaaa",
        subject: "Fix it",
        author: "Ada",
        at: 1760000000000,
      },
      { sha: "b".repeat(40), shortSha: "bbbbbbb", subject: "" },
    ],
  );
});

const labels = (entries: MenuEntry[]) =>
  entries.map((entry) =>
    "label" in entry ? entry.label : "separator" in entry ? "—" : "",
  );

test("the scope menu offers what the folder has, as the original orders it", () => {
  const commits = Array.from({ length: 52 }, (_, i) => ({
    sha: `${i}`.padStart(40, "a"),
    shortSha: `${i}`.padStart(7, "a"),
    subject: i === 0 ? "" : `commit ${i}`,
  }));
  const data: WorkingTreeChanges = {
    state: "ready",
    scope: "branch",
    base: "main",
    defaultBase: "main",
    diff: "",
    lineCounts: {},
    dirty: true,
    commits,
  };
  const picked: unknown[] = [];
  const entries = scopeEntries({
    data,
    scope: { kind: "branch" },
    base: "main",
    branches: { state: "ready", names: ["main", "dev"] },
    onScope: (scope) => picked.push(scope),
  });
  assert.deepEqual(labels(entries), [
    "All changes",
    "Uncommitted changes",
    "—",
    "Compare against",
    "—",
    "Commits",
  ]);
  const [all, , , compare, , list] = entries as Extract<
    MenuEntry,
    { label: string }
  >[];
  assert.equal(all.value, "vs main");
  assert.equal(all.checked, true);
  assert.equal(compare.value, "main");
  assert.deepEqual(
    compare.submenu?.map((row) =>
      "label" in row ? [row.label, row.value] : [],
    ),
    [
      ["main", "default"],
      ["dev", undefined],
    ],
  );
  assert.equal(compare.searchEmpty, "No branches match");
  (compare.submenu?.[1] as { onSelect: () => void }).onSelect();
  assert.deepEqual(picked.pop(), { kind: "branch", base: "dev" });
  assert.equal(list.value, "52");
  assert.equal(list.submenu?.length, 51);
  assert.equal(labels(list.submenu ?? [])[0], "(no message)");
  assert.equal(labels(list.submenu ?? [])[50], "2 older commits not shown");
  assert.equal(list.searchEmpty, "No match in the newest 50 commits");

  // Clean and without commits: neither Uncommitted changes nor Commits.
  const clean = scopeEntries({
    data: { ...data, dirty: false, commits: [] },
    scope: { kind: "branch" },
    base: "main",
    branches: { state: "loading" },
    onScope: () => {},
  });
  assert.deepEqual(labels(clean), ["All changes", "—", "Compare against"]);
  const rows = (clean[2] as { submenu: MenuEntry[] }).submenu;
  assert.deepEqual(labels(rows), ["main", "Loading branches…"]);
});

test("the trigger reads the range, the uncommitted scope or the commit", () => {
  const data: WorkingTreeChanges = {
    state: "ready",
    scope: "branch",
    base: "main",
    diff: "",
    lineCounts: {},
    commits: [{ sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "Fix" }],
  };
  assert.equal(
    scopeText(data, { kind: "branch" }, "main"),
    "main → working tree",
  );
  assert.equal(
    scopeText({ ...data, scope: "uncommitted" }, { kind: "uncommitted" }, "x"),
    "Uncommitted changes",
  );
  assert.equal(
    scopeText(
      { ...data, scope: "commit", head: "aaaaaaa" },
      { kind: "commit", sha: "a".repeat(40) },
      "main",
    ),
    "aaaaaaa Fix",
  );
  rememberScope("/p", { kind: "uncommitted" });
  assert.deepEqual(rememberedScope("/p"), { kind: "uncommitted" });
  rememberScope("/p", { kind: "branch" });
  assert.deepEqual(rememberedScope("/p"), { kind: "branch" });
});

test("the branch row's behind count and branch page", () => {
  assert.equal(behindLabel(1, "main"), "1 commit behind main");
  assert.equal(behindLabel(3, "main"), "3 commits behind main");
  assert.equal(
    branchUrl("octo/hello", "feature/a b#1"),
    "https://github.com/octo/hello/tree/feature/a%20b%231",
  );
});
