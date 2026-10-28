import test from "node:test";
import assert from "node:assert/strict";
import {
  FileDocuments,
  fileAutoSaveDelay,
  type FileDocumentBridge,
} from "../../src/files/file-documents";
import {
  moveFileTab,
  nextFileTab,
  activeAfterFileClose,
  openFileTab,
} from "../../src/files/file-tabs";
import {
  fileTreeSize,
  fileTreeMaximum,
  normaliseFileTreeWidth,
  boundedFileTreeWidth,
} from "../../src/files/file-tree-resize";
import {
  parseFilePreferences,
  defaultFilePreferences,
} from "../../src/files/file-preferences";
import type {
  ProjectFile,
  ProjectWriteResult,
} from "../../shared/project-files";
const file = (content = "original", revision = "1"): ProjectFile => ({
  path: "one.ts",
  content,
  bytes: content.length,
  writable: true,
  revision: revision.repeat(64),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const ready = (docs: FileDocuments, path = "one.ts") => {
  const d = docs.snapshot()[path];
  assert.equal(d?.state, "ready");
  if (d?.state !== "ready") throw Error("not ready");
  return d;
};
test("editor auto-save waits the reference 1000ms and writes the exact read revision", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let writes = 0,
    expected = "";
  const docs = new FileDocuments("session", {
    readProjectFile: async () => file(),
    writeProjectFile: async (_id, _path, text, revision) => {
      writes++;
      expected = revision;
      return { status: "saved", file: file(text, "2") };
    },
  });
  t.after(() => docs.dispose());
  await docs.open("one.ts");
  docs.edit("one.ts", "changed");
  t.mock.timers.tick(fileAutoSaveDelay - 1);
  assert.equal(writes, 0);
  t.mock.timers.tick(1);
  await docs.settle();
  assert.equal(writes, 1);
  assert.equal(expected, "1".repeat(64));
  assert.equal(ready(docs).dirty, false);
  assert.equal(ready(docs).value, "changed");
});
test("manual mode keeps edits until explicit save and reverts without writing", async (t) => {
  let writes = 0;
  const docs = new FileDocuments("session", {
    readProjectFile: async () => file(),
    writeProjectFile: async (_id, _path, text) => {
      writes++;
      return { status: "saved", file: file(text, "2") };
    },
  });
  t.after(() => docs.dispose());
  docs.setAutoSave(false);
  await docs.open("one.ts");
  docs.edit("one.ts", "draft");
  assert.equal(writes, 0);
  assert.deepEqual(docs.dirty(), ["one.ts"]);
  assert.equal(await docs.save("one.ts"), true);
  assert.equal(writes, 1);
  docs.edit("one.ts", "discard this");
  docs.revert("one.ts");
  assert.equal(ready(docs).value, "draft");
  assert.equal(ready(docs).dirty, false);
  assert.equal(writes, 1);
});
test("a save in flight never clears newer typing; the next save uses its returned revision", async (t) => {
  const first = deferred<ProjectWriteResult>(),
    writes: { text: string; revision: string }[] = [];
  const docs = new FileDocuments("session", {
    readProjectFile: async () => file(),
    writeProjectFile: async (_id, _path, text, revision) => {
      writes.push({ text, revision });
      return writes.length === 1
        ? first.promise
        : { status: "saved", file: file(text, "3") };
    },
  });
  t.after(() => docs.dispose());
  docs.setAutoSave(false);
  await docs.open("one.ts");
  docs.edit("one.ts", "first");
  const save = docs.save("one.ts");
  docs.edit("one.ts", "newer");
  first.resolve({ status: "saved", file: file("first", "2") });
  await save;
  assert.equal(ready(docs).value, "newer");
  assert.equal(ready(docs).saved, "first");
  assert.equal(ready(docs).dirty, true);
  await docs.save("one.ts");
  assert.deepEqual(writes, [
    { text: "first", revision: "1".repeat(64) },
    { text: "newer", revision: "2".repeat(64) },
  ]);
  assert.equal(ready(docs).dirty, false);
});
test("conflict and synchronous write failure retain edits and recover on a real reload/retry", async (t) => {
  let fail = true,
    writes = 0;
  const bridge: FileDocumentBridge = {
    readProjectFile: async () => file(),
    writeProjectFile: () => {
      writes++;
      if (fail) throw Error("sync failure");
      return Promise.resolve({
        status: "conflict",
        currentRevision: "2".repeat(64),
      });
    },
  };
  const docs = new FileDocuments("session", bridge);
  t.after(() => docs.dispose());
  docs.setAutoSave(false);
  await docs.open("one.ts");
  docs.edit("one.ts", "draft");
  assert.equal(await docs.save("one.ts"), false);
  assert.equal(ready(docs).problem, "failed");
  fail = false;
  docs.edit("one.ts", "fixed draft");
  assert.equal(await docs.save("one.ts"), false);
  assert.equal(ready(docs).problem, "conflict");
  const beforeBlur = writes;
  assert.equal(await docs.saveOnBlur("one.ts"), false);
  assert.equal(writes, beforeBlur);
  assert.equal(ready(docs).problem, "conflict");
  assert.equal(ready(docs).saving, false);
  assert.equal(ready(docs).file.revision, "1".repeat(64));
  assert.equal(ready(docs).value, "fixed draft");
  bridge.readProjectFile = async () => file("external", "2");
  docs.revert("one.ts");
  await docs.open("one.ts", true);
  assert.equal(ready(docs).value, "external");
  assert.equal(ready(docs).reload, 1);
  assert.equal(ready(docs).dirty, false);
});
test("closed tabs and disposed sessions ignore late reads and writes, including StrictMode reactivation", async (t) => {
  const old = deferred<ProjectFile>(),
    fresh = deferred<ProjectFile>();
  let count = 0;
  const docs = new FileDocuments("session", {
    readProjectFile: () => (++count === 1 ? old.promise : fresh.promise),
  });
  t.after(() => docs.dispose());
  const initial = docs.open("one.ts");
  docs.close("one.ts");
  const current = docs.open("one.ts");
  fresh.resolve(file("fresh", "2"));
  await current;
  old.resolve(file("stale", "1"));
  await initial;
  assert.equal(ready(docs).value, "fresh");
  docs.dispose();
  docs.activate();
  await docs.open("two.ts");
  assert.equal(ready(docs, "two.ts").value, "fresh");
});
test("legacy, remote/read-only and invalid-encoding results cannot claim edit capability", async (t) => {
  const variants = [
    { ...file(), writable: undefined },
    { ...file(), revision: undefined },
    { ...file(), invalidEncoding: true },
    { ...file(), binary: true },
  ];
  for (const variant of variants) {
    let writes = 0;
    const docs = new FileDocuments("session", {
      readProjectFile: async () => variant,
      writeProjectFile: async () => {
        writes++;
        return { status: "saved", file: file() };
      },
    });
    t.after(() => docs.dispose());
    await docs.open("one.ts");
    docs.edit("one.ts", "bad");
    assert.equal(docs.writable("one.ts"), false);
    assert.equal(ready(docs).value, "original");
    assert.equal(writes, 0);
  }
});
test("file tabs traverse in both directions and reorder by either platform modifier without losing identity", () => {
  const tabs = ["one", "two", "three"];
  assert.equal(nextFileTab(tabs, "one", "ArrowLeft"), "three");
  assert.equal(nextFileTab(tabs, "one", "ArrowLeft", true), "two");
  assert.equal(nextFileTab(tabs, "two", "Home"), "one");
  assert.equal(nextFileTab(tabs, "two", "End"), "three");
  assert.deepEqual(moveFileTab(tabs, "two", -1), ["two", "one", "three"]);
  assert.deepEqual(moveFileTab(tabs, "three", 1), tabs);
  assert.equal(activeAfterFileClose(tabs, ["one", "three"], "two"), "three");
  assert.equal(activeAfterFileClose(tabs, ["one"], "three"), "one");
  assert.equal(activeAfterFileClose(tabs, [], "one"), undefined);
  assert.deepEqual(openFileTab(["one", "two"], "three", "two", true), {
    tabs: ["one", "three"],
    preview: "three",
  });
  assert.deepEqual(openFileTab(["one", "two"], "two", "two", true, true), {
    tabs: ["one", "two"],
    preview: undefined,
  });
});
test("file tree bounds match source 240/160/640 and preserve 160px for the editor", () => {
  assert.deepEqual(fileTreeSize, {
    default: 240,
    min: 160,
    max: 640,
    editorMin: 160,
    hideBelow: 80,
  });
  assert.equal(fileTreeMaximum(400), 240);
  assert.equal(fileTreeMaximum(900), 640);
  assert.equal(fileTreeMaximum(140), 0);
  assert.equal(boundedFileTreeWidth(240, 300), 140);
  assert.equal(boundedFileTreeWidth(100, 600), 160);
  assert.equal(normaliseFileTreeWidth(NaN), 240);
  assert.equal(normaliseFileTreeWidth(9999), 640);
});
test("file preference corruption never enables an unsupported tab size or non-boolean state", () => {
  assert.deepEqual(
    parseFilePreferences('{"autoSave":"false","tabSize":3}'),
    defaultFilePreferences,
  );
  assert.deepEqual(parseFilePreferences("broken"), defaultFilePreferences);
  assert.equal(
    parseFilePreferences('{"autoSave":false,"tabSize":8}').autoSave,
    false,
  );
});
