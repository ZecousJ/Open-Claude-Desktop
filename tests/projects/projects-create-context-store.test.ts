import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareProjectContext } from "../../electron/projects/project-create-context";
import {
  ProjectKnowledgeStore,
  knowledgeFileLimit,
} from "../../electron/projects/project-knowledge";
import type { Project } from "../../shared/types";
const project: Project = {
  id: "new-project",
  name: "New",
  description: "",
  instructions: "",
  createdAt: 1,
};
function disk(t: import("node:test").TestContext) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b33-create-"));
  const root = path.join(parent, "account");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root };
}
const file = (name = "notes.txt", text = "hello") => ({
  name,
  data: new Uint8Array(Buffer.from(text)),
});

test("all context is validated in staging and becomes readable only at commit", (t) => {
  const { parent, root } = disk(t),
    prepared = prepareProjectContext(root, project, {
      files: [file()],
      text: "Unicode 中 context",
    });
  assert.equal(fs.existsSync(path.join(root, "projects", project.id)), false);
  prepared.commit();
  prepared.commit();
  const store = new ProjectKnowledgeStore(root, () => [project]);
  assert.deepEqual(
    store
      .list(project.id)
      .files.map((file) => file.name)
      .sort(),
    ["notes.txt", "project-context.txt"],
  );
  assert.equal(store.read(project.id, "notes.txt").kind, "text");
  assert.deepEqual(fs.readdirSync(parent), ["account"]);
  prepared.rollback();
  prepared.rollback();
  assert.equal(fs.existsSync(path.join(root, "projects", project.id)), false);
});
test("empty context is a valid isolated transaction and rollback before commit leaves nothing published", (t) => {
  const { parent, root } = disk(t);
  const first = prepareProjectContext(root, project, { files: [] });
  first.rollback();
  assert.deepEqual(fs.readdirSync(parent), ["account"]);
  const second = prepareProjectContext(root, project, {
    files: [],
    text: "   ",
  });
  second.commit();
  assert.equal(
    new ProjectKnowledgeStore(root, () => [project]).list(project.id).files
      .length,
    0,
  );
  second.rollback();
});
test("invalid UTF8, unsupported files, collisions, traversal, file count and size failures publish nothing", (t) => {
  const { parent, root } = disk(t);
  const invalid = [
    { files: [{ name: "bad.txt", data: new Uint8Array([0xff]) }] },
    { files: [file("program.exe")] },
    { files: [file("duplicate.txt"), file("duplicate.txt")] },
    { files: [file("../escape.txt")] },
    { files: [file("/absolute.txt")] },
    { files: [file("project-context.txt")], text: "duplicate text" },
    { files: Array.from({ length: 201 }, (_, i) => file(`${i}.txt`)) },
    {
      files: [
        { name: "large.txt", data: new Uint8Array(knowledgeFileLimit + 1) },
      ],
    },
  ];
  for (const input of invalid) {
    assert.throws(() => prepareProjectContext(root, project, input));
    assert.equal(fs.existsSync(path.join(root, "projects", project.id)), false);
    assert.deepEqual(fs.readdirSync(parent), ["account"]);
  }
  assert.throws(() =>
    prepareProjectContext(
      root,
      { ...project, id: "../escape" },
      { files: [file()] },
    ),
  );
});
test("existing context and symlink destinations are never replaced", (t) => {
  const { root, parent } = disk(t),
    external = path.join(parent, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "kept.txt"), "keep");
  fs.mkdirSync(path.join(root, "projects"));
  fs.symlinkSync(external, path.join(root, "projects", project.id), "dir");
  const prepared = prepareProjectContext(root, project, { files: [file()] });
  assert.throws(() => prepared.commit(), /already exists/);
  prepared.rollback();
  assert.equal(
    fs.readFileSync(path.join(external, "kept.txt"), "utf8"),
    "keep",
  );
  fs.unlinkSync(path.join(root, "projects", project.id));
  fs.mkdirSync(path.join(root, "projects", project.id));
  assert.throws(
    () => prepareProjectContext(root, project, { files: [] }).commit(),
    /already exists/,
  );
  fs.rmdirSync(path.join(root, "projects", project.id));
  fs.rmdirSync(path.join(root, "projects"));
  fs.symlinkSync(external, path.join(root, "projects"), "dir");
  const link = prepareProjectContext(root, project, { files: [file()] });
  assert.throws(() => link.commit());
  link.rollback();
  assert.deepEqual(fs.readdirSync(external), ["kept.txt"]);
});
test("rollback preserves foreign files and replaced destinations", (t) => {
  const { root } = disk(t),
    prepared = prepareProjectContext(root, project, { files: [file()] });
  prepared.commit();
  const target = path.join(root, "projects", project.id),
    knowledge = path.join(target, "knowledge");
  fs.writeFileSync(path.join(knowledge, "foreign.txt"), "foreign");
  prepared.rollback();
  assert.equal(
    fs.readFileSync(path.join(knowledge, "foreign.txt"), "utf8"),
    "foreign",
  );
  assert.equal(fs.existsSync(path.join(knowledge, "notes.txt")), false);
  const other = { ...project, id: "replacement" };
  const replaced = prepareProjectContext(root, other, { files: [file()] });
  replaced.commit();
  const old = path.join(root, "projects", other.id);
  fs.renameSync(old, old + "-moved");
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, "new.txt"), "new owner");
  replaced.rollback();
  assert.equal(fs.readFileSync(path.join(old, "new.txt"), "utf8"), "new owner");
});

test("rollback never follows a replaced knowledge parent symlink", (t) => {
  const { root, parent } = disk(t);
  const prepared = prepareProjectContext(root, project, { files: [file()] });
  prepared.commit();
  const knowledge = path.join(root, "projects", project.id, "knowledge");
  const moved = path.join(parent, "moved-knowledge");
  fs.renameSync(knowledge, moved);
  fs.symlinkSync(moved, knowledge, "dir");
  prepared.rollback();
  assert.equal(fs.readFileSync(path.join(moved, "notes.txt"), "utf8"), "hello");
});

test("a whole-batch total quota failure cleans staging and publishes no valid partial files", (t) => {
  const { root, parent } = disk(t);
  const bytes = new Uint8Array(knowledgeFileLimit);
  assert.throws(
    () =>
      prepareProjectContext(root, project, {
        files: Array.from({ length: 11 }, (_, index) => ({
          name: `${index}.txt`,
          data: bytes,
        })),
      }),
    /100 MB/,
  );
  assert.equal(fs.existsSync(path.join(root, "projects", project.id)), false);
  assert.deepEqual(fs.readdirSync(parent), ["account"]);
});

test("rollback preserves an owned path whose contents were subsequently edited", (t) => {
  const { root } = disk(t);
  const prepared = prepareProjectContext(root, project, { files: [file()] });
  prepared.commit();
  const target = path.join(
    root,
    "projects",
    project.id,
    "knowledge",
    "notes.txt",
  );
  fs.writeFileSync(target, "user changed these contents");
  prepared.rollback();
  assert.equal(fs.readFileSync(target, "utf8"), "user changed these contents");
});
