import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  readProjectFile,
  writeProjectFile,
  changesHookConfiguration,
  projectFileLimit,
} from "../../electron/projects/project-files";

function workspace(t: { after: (fn: () => void) => unknown }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-editor-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "file.ts");
  fs.writeFileSync(file, "export const value = 1;\r\n");
  return { root, file, read: () => readProjectFile(root, "file.ts") };
}
test("local editor reads expose real byte revisions and a conditional atomic save preserves text and file mode", (t) => {
  const w = workspace(t);
  fs.chmodSync(w.file, 0o751);
  const before = w.read();
  assert.equal(before.writable, true);
  assert.equal(
    before.revision,
    createHash("sha256").update(fs.readFileSync(w.file)).digest("hex"),
  );
  const content = "\uFEFFexport const value = 2;\r\n";
  const saved = writeProjectFile(w.root, "file.ts", content, before.revision!);
  assert.equal(saved.status, "saved");
  if (saved.status !== "saved") return;
  assert.equal(saved.file.content, content);
  assert.notEqual(saved.file.revision, before.revision);
  assert.equal(fs.readFileSync(w.file, "utf8"), content);
  assert.equal(fs.statSync(w.file).mode & 0o777, 0o751);
  assert.deepEqual(fs.readdirSync(w.root), ["file.ts"]);
});
test("an intervening write or deletion never overwrites the latest file", (t) => {
  const w = workspace(t),
    before = w.read();
  fs.writeFileSync(w.file, "external edit");
  const conflict = writeProjectFile(
    w.root,
    "file.ts",
    "stale draft",
    before.revision!,
  );
  assert.equal(conflict.status, "conflict");
  assert.equal(fs.readFileSync(w.file, "utf8"), "external edit");
  fs.unlinkSync(w.file);
  assert.deepEqual(
    writeProjectFile(w.root, "file.ts", "draft", before.revision!),
    { status: "missing" },
  );
});
test("save refuses external paths and symlinks, and protects Git metadata through an internal alias", (t) => {
  const w = workspace(t),
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-editor-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const privateFile = path.join(outside, "private.txt");
  fs.writeFileSync(privateFile, "untouched");
  fs.symlinkSync(privateFile, path.join(w.root, "outside.txt"));
  const hash = w.read().revision!;
  for (const relative of ["../private.txt", privateFile, "outside.txt"])
    assert.throws(
      () => writeProjectFile(w.root, relative, "bad", hash),
      /outside/,
    );
  fs.mkdirSync(path.join(w.root, ".git"));
  fs.writeFileSync(path.join(w.root, ".git", "config"), "[core]\n");
  fs.symlinkSync(
    path.join(w.root, ".git", "config"),
    path.join(w.root, "alias.txt"),
  );
  const git = readProjectFile(w.root, "alias.txt");
  assert.equal(git.writable, false);
  assert.deepEqual(
    writeProjectFile(w.root, "alias.txt", "changed", git.revision!),
    { status: "denied", reason: "git-metadata" },
  );
  assert.equal(fs.readFileSync(privateFile, "utf8"), "untouched");
});
test("read-only, binary, oversized and invalid UTF-8 files never become writable stand-ins", (t) => {
  const w = workspace(t);
  fs.chmodSync(w.file, 0o444);
  const ro = w.read();
  assert.equal(ro.writable, false);
  assert.deepEqual(writeProjectFile(w.root, "file.ts", "draft", ro.revision!), {
    status: "denied",
    reason: "read-only",
  });
  fs.chmodSync(w.file, 0o644);
  fs.writeFileSync(w.file, Buffer.from([0xc3, 0x28]));
  const invalid = w.read();
  assert.equal(invalid.invalidEncoding, true);
  assert.equal(invalid.writable, false);
  assert.deepEqual(
    writeProjectFile(w.root, "file.ts", "draft", invalid.revision!),
    { status: "denied", reason: "unsupported-encoding" },
  );
  fs.writeFileSync(w.file, Buffer.from([0, 1, 2]));
  assert.equal(w.read().binary, true);
  assert.equal(w.read().writable, false);
  fs.writeFileSync(w.file, "x".repeat(projectFileLimit + 1));
  assert.equal(w.read().tooLarge, true);
  assert.throws(
    () =>
      writeProjectFile(
        w.root,
        "file.ts",
        "x".repeat(projectFileLimit + 1),
        "0".repeat(64),
      ),
    /too large/,
  );
  assert.throws(
    () => writeProjectFile(w.root, "file.ts", "x", "not-a-revision"),
    /Read the file/,
  );
});
test("the native reference's hook-manager package keys are guarded, while ordinary package edits work", (t) => {
  const w = workspace(t),
    file = path.join(w.root, "package.json");
  const before = JSON.stringify({
    name: "example",
    husky: { hooks: { "pre-commit": "unchanged" } },
  });
  fs.writeFileSync(file, before);
  for (const key of [
    "lint-staged",
    "husky",
    "commitlint",
    "pre-commit",
    "precommit",
    "gitHooks",
    "nano-staged",
  ])
    assert.equal(
      changesHookConfiguration(
        before,
        JSON.stringify({ ...JSON.parse(before), [key]: "changed" }),
      ),
      true,
      key,
    );
  const original = readProjectFile(w.root, "package.json");
  assert.deepEqual(
    writeProjectFile(
      w.root,
      "package.json",
      JSON.stringify({ name: "example", husky: "modified" }),
      original.revision!,
    ),
    { status: "denied", reason: "hook-config" },
  );
  const allowed = writeProjectFile(
    w.root,
    "package.json",
    JSON.stringify({ ...JSON.parse(before), name: "renamed" }),
    original.revision!,
  );
  assert.equal(allowed.status, "saved");
});
test("a failed replacement keeps the original bytes and removes its temporary sibling", (t) => {
  const w = workspace(t),
    before = w.read(),
    rename = fs.renameSync;
  fs.renameSync = (() => {
    throw new Error("synthetic rename failure");
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () => writeProjectFile(w.root, "file.ts", "draft", before.revision!),
      /rename failure/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(w.read().revision, before.revision);
  assert.deepEqual(fs.readdirSync(w.root), ["file.ts"]);
});
test("changes discovered immediately before replacement are returned as conflicts", (t) => {
  const w = workspace(t),
    before = w.read(),
    sync = fs.fsyncSync;
  fs.fsyncSync = ((fd: number) => {
    sync(fd);
    fs.writeFileSync(w.file, "late external edit");
  }) as typeof fs.fsyncSync;
  try {
    assert.equal(
      writeProjectFile(w.root, "file.ts", "stale", before.revision!).status,
      "conflict",
    );
  } finally {
    fs.fsyncSync = sync;
  }
  assert.equal(fs.readFileSync(w.file, "utf8"), "late external edit");
  assert.deepEqual(fs.readdirSync(w.root), ["file.ts"]);
});
