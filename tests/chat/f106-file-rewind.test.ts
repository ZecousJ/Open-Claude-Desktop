import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { rewindCodeFiles } from "../../electron/engine/code-file-rewind";
import { reverseDiff } from "../../electron/engine/rewind-files";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f106-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  return {
    root,
    git,
    write: (name: string, text: string) =>
      fs.writeFileSync(path.join(root, name), text),
    read: (name: string) => fs.readFileSync(path.join(root, name), "utf8"),
  };
}

test("file rewind previews and reverses actual Git patches without changing the index", (t) => {
  const f = fixture(t);
  f.write("file.txt", "alpha\nbeta\ngamma\n");
  f.git("add", "file.txt");
  f.write("file.txt", "alpha\nBETA\nextra\ngamma\n");
  const diff = f.git("diff", "--", "file.txt");
  const changes = [{ path: "file.txt", kind: "update" as const, diff }];
  assert.equal(rewindCodeFiles(changes, f.root, true).canRewind, true);
  assert.equal(f.read("file.txt"), "alpha\nBETA\nextra\ngamma\n");
  assert.equal(rewindCodeFiles(changes, f.root, false).canRewind, true);
  assert.equal(f.read("file.txt"), "alpha\nbeta\ngamma\n");
  assert.equal(f.git("diff"), "");
  assert.equal(f.git("show", ":file.txt"), "alpha\nbeta\ngamma\n");
});

test("a conflict leaves every file unchanged", (t) => {
  const f = fixture(t);
  f.write("one", "manual change\n");
  f.write("two", "agent created\n");
  const changes = [
    { path: "one", kind: "add" as const, diff: "agent created\n" },
    { path: "two", kind: "add" as const, diff: "agent created\n" },
  ];
  assert.equal(rewindCodeFiles(changes, f.root, false).canRewind, false);
  assert.equal(f.read("one"), "manual change\n");
  assert.equal(f.read("two"), "agent created\n");
});

test("restore applies repeated edits newest first and restores moved and deleted files", (t) => {
  const f = fixture(t);
  f.write("moved", "three\n");
  const changes = [
    {
      path: "original",
      kind: "update" as const,
      movePath: "moved",
      diff: "@@ -1 +1 @@\n-one\n+two\n",
    },
    {
      path: "moved",
      kind: "update" as const,
      diff: "@@ -1 +1 @@\n-two\n+three\n",
    },
    { path: "deleted", kind: "delete" as const, diff: "kept\n" },
  ];
  assert.equal(rewindCodeFiles(changes, f.root, false).canRewind, true);
  assert.equal(f.read("original"), "one\n");
  assert.equal(f.read("deleted"), "kept\n");
  assert.equal(fs.existsSync(path.join(f.root, "moved")), false);
});

test("real Git patches preserve missing final newlines and CRLF", (t) => {
  const f = fixture(t);
  for (const [before, after] of [
    ["before", "after\n"],
    ["before\n", "after"],
    ["a\r\nb\r\n", "a\r\nB\r\n"],
  ]) {
    f.write("file", before);
    f.git("add", "file");
    f.write("file", after);
    assert.equal(reverseDiff(after, f.git("diff", "--", "file")), before);
  }
});
