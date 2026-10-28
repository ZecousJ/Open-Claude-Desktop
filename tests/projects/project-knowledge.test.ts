import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  knowledgeFileLimit,
  knowledgeName,
  knowledgeProjectLimit,
  projectKnowledgeInstructions,
  ProjectKnowledgeStore,
} from "../../electron/projects/project-knowledge";
import { capacityVariant as projectCapacityVariant } from "../../src/collections/projects/KnowledgeList";
import type { Project } from "../../shared/types";
import type { AppContext } from "../../electron/app/app-context";
import { registerCollectionHandlers } from "../../electron/ipc/collections";

function temporary(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-knowledge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const project = (id: string): Project => ({
  id,
  name: `Project ${id}`,
  description: "",
  instructions: "",
  createdAt: 1,
});
const text = (value: string) => Buffer.from(value, "utf8");

test("project capacity uses the official accent, warning, and danger thresholds", () => {
  assert.equal(projectCapacityVariant(80), "accent");
  assert.equal(projectCapacityVariant(80.1), "warning");
  assert.equal(projectCapacityVariant(100), "danger");
});

test("files are copied into the project's folder and listed with sizes", (t) => {
  const root = temporary(t);
  const store = new ProjectKnowledgeStore(root, () => [project("p1")]);
  assert.deepEqual(store.list("p1").files, []);
  const result = store.add("p1", [
    { name: "notes.md", data: text("# Notes") },
    { name: "report.pdf", data: text("%PDF-1.7 body") },
  ]);
  assert.deepEqual(result.files.map((file) => [file.name, file.bytes]).sort(), [
    ["notes.md", 7],
    ["report.pdf", 13],
  ]);
  assert.equal(result.bytes, 20);
  assert.equal(result.limit, knowledgeProjectLimit);
  const folder = path.join(root, "projects", "p1", "knowledge");
  assert.equal(
    fs.readFileSync(path.join(folder, "notes.md"), "utf8"),
    "# Notes",
  );
  // Same name replaces; remove deletes.
  store.add("p1", [{ name: "notes.md", data: text("v2") }]);
  assert.equal(fs.readFileSync(path.join(folder, "notes.md"), "utf8"), "v2");
  assert.deepEqual(
    store.remove("p1", "notes.md").files.map((file) => file.name),
    ["report.pdf"],
  );
  assert.throws(() => store.remove("p1", "notes.md"), /no longer/);
});

test("types, encodings, names and sizes are checked before anything is copied", (t) => {
  const root = temporary(t);
  const store = new ProjectKnowledgeStore(root, () => [project("p1")]);
  assert.throws(
    () => store.add("p1", [{ name: "tool.exe", data: text("x") }]),
    /text files or PDFs/,
  );
  assert.throws(
    () => store.add("p1", [{ name: "fake.pdf", data: text("hello") }]),
    /isn't a PDF/,
  );
  assert.throws(
    () =>
      store.add("p1", [
        { name: "ok.txt", data: text("fine") },
        { name: "bin.txt", data: Buffer.from([0xff, 0xfe, 0x00]) },
      ]),
    /UTF-8/,
  );
  // The valid file of a refused batch was not copied.
  assert.deepEqual(store.list("p1").files, []);
  assert.throws(
    () =>
      store.add("p1", [
        { name: "big.txt", data: Buffer.alloc(knowledgeFileLimit + 1, 97) },
      ]),
    /too large/,
  );
  assert.equal(knowledgeName("docs/guide.txt"), "docs guide.txt");
  // An SVG or Mermaid artifact copied to the project keeps its extension.
  assert.equal(knowledgeName("Logo.svg"), "Logo.svg");
  assert.equal(knowledgeName("Flow.mermaid"), "Flow.mermaid");
  assert.throws(() => knowledgeName("../../etc/passwd.txt"), /file name/);
  assert.throws(() => knowledgeName(".hidden.md"), /file name/);
  assert.throws(() => store.list("../p1"), /no longer exists/);
  assert.throws(() => store.list("other"), /no longer exists/);
});

test("the project's total is capped", (t) => {
  const root = temporary(t);
  const store = new ProjectKnowledgeStore(root, () => [project("p1")]);
  const chunk = Buffer.alloc(knowledgeFileLimit, 97);
  for (let i = 0; i < 10; i++)
    store.add("p1", [{ name: `part${i}.txt`, data: chunk }]);
  assert.throws(
    () => store.add("p1", [{ name: "one-more.txt", data: text("x") }]),
    /up to 100 MB/,
  );
  // Replacing a file of the same size still fits.
  store.add("p1", [{ name: "part0.txt", data: chunk }]);
});

test("files of deleted projects are removed; chats are told where files are", (t) => {
  const root = temporary(t);
  let projects = [project("p1"), project("p2")];
  const store = new ProjectKnowledgeStore(root, () => projects);
  store.add("p1", [{ name: "a.md", data: text("a") }]);
  store.add("p2", [{ name: "b.md", data: text("b") }]);
  const instructions = projectKnowledgeInstructions(root, projects[0])!;
  assert.match(instructions, /Project p1/);
  assert.match(instructions, /- a\.md/);
  assert.ok(
    instructions.includes(path.join(root, "projects", "p1", "knowledge")),
  );
  assert.doesNotMatch(instructions, /b\.md/);
  assert.equal(projectKnowledgeInstructions(root, undefined), undefined);
  assert.equal(projectKnowledgeInstructions(root, project("empty")), undefined);
  projects = [project("p1")];
  store.prune();
  assert.equal(fs.existsSync(path.join(root, "projects", "p2")), false);
  assert.equal(fs.existsSync(path.join(root, "projects", "p1")), true);
});

test("the web's picked files are added with the same checks", async (t) => {
  const root = temporary(t);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = {
    store: { root, projects: [project("p1")] },
    onSettingsChanged: () => {},
    onAccountActivated() {},
    onAccountDeactivating() {},
  };
  registerCollectionHandlers(
    (name, fn) => handlers.set(name, fn),
    ctx as unknown as AppContext,
  );
  const add = handlers.get("addProjectKnowledgeFiles")!;
  const result = (await add("p1", [
    { name: "notes.md", data: new TextEncoder().encode("# Notes") },
  ])) as { files: { name: string; bytes: number }[] };
  assert.deepEqual(
    result.files.map((file) => [file.name, file.bytes]),
    [["notes.md", 7]],
  );
  const read = handlers.get("readProjectKnowledge")!;
  assert.deepEqual(await read("p1", "notes.md"), {
    name: "notes.md",
    bytes: 7,
    kind: "text",
    text: "# Notes",
  });
  assert.throws(() => read("nope", "notes.md"), /no longer exists/);
  assert.throws(() => read("p1", "../notes.md"));
  // A type the agent can't read, or bytes that aren't bytes, change nothing.
  await assert.rejects(async () =>
    add("p1", [{ name: "a.exe", data: new Uint8Array(1) }]),
  );
  await assert.rejects(async () => add("p1", [{ name: "b.md", data: "x" }]));
  await assert.rejects(async () => add("p1", []));
  await assert.rejects(async () =>
    add("nope", [{ name: "c.md", data: new Uint8Array(1) }]),
  );
  assert.equal(
    (
      (await handlers.get("listProjectKnowledge")!("p1")) as {
        files: unknown[];
      }
    ).files.length,
    1,
  );
  const remove = handlers.get("removeProjectKnowledge")!;
  assert.throws(() => remove("p1", ["notes.md", "missing.md"]));
  assert.throws(() => remove("p1", []));
  const removed = (await remove("p1", ["notes.md"])) as { files: unknown[] };
  assert.deepEqual(removed.files, []);
  assert.throws(() => read("p1", "notes.md"));
});
