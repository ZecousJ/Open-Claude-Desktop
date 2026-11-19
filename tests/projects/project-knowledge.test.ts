import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  knowledgeFileLimit,
  knowledgeName,
  knowledgeProjectLimit,
  projectKnowledgeInstructions,
  ProjectKnowledgeStore,
} from "../../electron/projects/project-knowledge";
import { capacityVariant as projectCapacityVariant } from "../../src/collections/projects/KnowledgeList";
import type { Project } from "../../shared/types";
import type { KnowledgePreview } from "../../shared/collections-api";
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

test("files are copied into the project's folder and listed with sizes", async (t) => {
  const root = temporary(t);
  const store = new ProjectKnowledgeStore(root, () => [project("p1")]);
  assert.deepEqual(store.list("p1").files, []);
  const result = await store.add("p1", [
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
  await store.add("p1", [{ name: "notes.md", data: text("v2") }]);
  assert.equal(fs.readFileSync(path.join(folder, "notes.md"), "utf8"), "v2");
  assert.deepEqual(
    store.remove("p1", "notes.md").files.map((file) => file.name),
    ["report.pdf"],
  );
  assert.throws(() => store.remove("p1", "notes.md"), /no longer/);
});

test("Windows add waits for the published file and metadata to be flushed", async (t) => {
  const root = temporary(t);
  const store = new ProjectKnowledgeStore(root, () => [project("p1")]);
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => {
    Object.defineProperty(process, "platform", { value: platform });
  });

  let entered!: () => void;
  const finalFlush = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const resume = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const open = fs.promises.open;
  const rename = fs.renameSync;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const name = path.basename(String(args[0]));
    const sync = handle.sync.bind(handle);
    t.mock.method(handle, "sync", async () => {
      if (name === "knowledge-names.json") {
        entered();
        await resume;
      }
      await sync();
      events.push(`flush ${name}`);
    });
    return handle;
  });
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
    rename(...args);
    events.push(`rename ${path.basename(String(args[1]))}`);
  });
  const upload = store.add("p1", [{
    name: "notes.txt",
    displayName: "Notes.txt",
    data: text("notes"),
    source: {
      provider: "github",
      repository: "owner/repo",
      branch: "main",
      path: "notes.txt",
      status: "idle",
      lastSyncedAt: 1,
    },
  }]).then((result) => {
    events.push("confirmed");
    return result;
  });
  try {
    await Promise.race([finalFlush, upload]);
    await nextTurn();
    assert.deepEqual(events, [
      "flush .notes.txt.tmp",
      "rename notes.txt",
      "rename knowledge-sources.json",
      "rename knowledge-names.json",
      "flush notes.txt",
      "flush knowledge-sources.json",
    ]);
  } finally {
    release();
    await upload;
  }
  assert.deepEqual(events.slice(-2), ["flush knowledge-names.json", "confirmed"]);
});

test("types, encodings, names and sizes are checked before anything is copied", async (t) => {
  const root = temporary(t);
  const store = new ProjectKnowledgeStore(root, () => [project("p1")]);
  await assert.rejects(
    () => store.add("p1", [{ name: "tool.exe", data: text("x") }]),
    /unsupported project file type/,
  );
  await assert.rejects(
    () => store.add("p1", [{ name: "fake.pdf", data: text("hello") }]),
    /isn't a PDF/,
  );
  await assert.rejects(
    () =>
      store.add("p1", [
        { name: "ok.txt", data: text("fine") },
        { name: "bin.txt", data: Buffer.from([0xff, 0xfe, 0x00]) },
      ]),
    /UTF-8/,
  );
  // The valid file of a refused batch was not copied.
  assert.deepEqual(store.list("p1").files, []);
  await assert.rejects(
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
  assert.equal(knowledgeName(".hidden.md"), ".hidden.md");
  assert.equal(knowledgeName(".env"), ".env");
  assert.throws(() => store.list("../p1"), /no longer exists/);
  assert.throws(() => store.list("other"), /no longer exists/);
});

test("concurrent additions from separate stores respect the project quota", async (t) => {
  const root = temporary(t);
  const store = new ProjectKnowledgeStore(root, () => [project("p1")]);
  const chunk = Buffer.alloc(25_000_000, 97);
  for (let i = 0; i < 3; i++)
    await store.add("p1", [{ name: `part${i}.txt`, data: chunk }]);
  const second = new ProjectKnowledgeStore(root, () => [project("p1")]);
  const firstAdd = store.add("p1", [{ name: "part3.txt", data: chunk }]);
  const rejectedAdd = second.add("p1", [{ name: "part4.txt", data: chunk }]);
  await assert.rejects(
    rejectedAdd,
    /up to 100 MB/,
  );
  assert.equal((await firstAdd).bytes, 100_000_000);
  assert.equal(second.list("p1").files.some((file) => file.name === "part4.txt"), false);
  // Replacing a file of the same size still fits.
  await store.add("p1", [{ name: "part0.txt", data: chunk }]);
});

test("files of deleted projects are removed; chats are told where files are", async (t) => {
  const root = temporary(t);
  let projects = [project("p1"), project("p2")];
  const store = new ProjectKnowledgeStore(root, () => projects);
  await store.add("p1", [{ name: "a.md", data: text("a") }]);
  await store.add("p2", [{ name: "b.md", data: text("b") }]);
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
  await assert.rejects(async () => read("nope", "notes.md"), /no longer exists/);
  await assert.rejects(async () => read("p1", "../notes.md"));
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
  await assert.rejects(async () => read("p1", "notes.md"));
});

test("large project reads leave the event loop free and retire the reply after descriptor I/O", async (t) => {
  const root = temporary(t);
  const name = "large.txt";
  const target = path.join(root, "projects", "p1", "knowledge", name);
  const contents = Buffer.alloc(knowledgeFileLimit, 0x61);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  const retiring: Array<() => void | Promise<void>> = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerCollectionHandlers((name, fn) => handlers.set(name, fn), {
    store: { root, projects: [project("p1")] },
    onSettingsChanged() {},
    onAccountActivated() {},
    onAccountDeactivating(callback: () => void | Promise<void>) {
      retiring.push(callback);
    },
  } as unknown as AppContext);
  const read = handlers.get("readProjectKnowledge")!;
  const open = fs.promises.open;
  let pause: (stage: "read" | "close") => Promise<void>;
  let opened = 0;
  let closed = 0;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (args[0] !== target) return handle;
    opened++;
    const readBytes = handle.read.bind(handle);
    t.mock.method(handle, "read", async (
      data: Buffer, offset: number, length: number, position: number,
    ) => {
      const result = await readBytes(data, offset, length, position);
      if (position === 0) await pause("read");
      return result;
    });
    const close = handle.close.bind(handle);
    t.mock.method(handle, "close", async () => {
      await close();
      closed++;
      await pause("close");
    });
    return handle;
  });

  for (const outcome of ["success", "retired", "io-failure"] as const) {
    let entered!: () => void;
    let release!: () => void;
    const atIo = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    pause = async (stage) => {
      if (stage !== (outcome === "retired" ? "close" : "read")) return;
      entered();
      await resume;
      if (outcome === "io-failure") throw new Error("Read failed.");
    };
    const pending = Promise.resolve(read("p1", name));
    let settled = false;
    const finish = () => { settled = true; };
    void pending.then(finish, finish);
    try {
      assert.ok(
        await Promise.race([atIo.then(() => true), pending.then(() => false)]),
        "Read completed before the controlled I/O point.",
      );
      await nextTurn();
      assert.equal(settled, false);
      if (outcome === "retired")
        for (const retire of retiring) await retire();
    } finally {
      release();
    }
    if (outcome === "success") {
      const preview = await pending as KnowledgePreview;
      assert.equal(preview.kind, "text");
      assert.equal(preview.bytes, contents.length);
      assert.ok(Buffer.from(preview.text).equals(contents));
    } else {
      await assert.rejects(pending, outcome === "retired" ? /account changed/ : /Read failed/);
    }
    assert.equal(opened, closed);
  }
});
