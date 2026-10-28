import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { captureGeneratedFiles } from "../../electron/artifacts/generated-files";
import { latestGeneratedFiles } from "../../shared/generated-files";
import { generatedArtifact } from "../../src/artifacts/generatedArtifact";
import { FileChangeView } from "../../src/transcript/tools/FileChangeView";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import type { Item, Turn, Conversation } from "../../shared/types";
const item = (filename: string, kind: any = { type: "add" }): Item => ({
  id: "patch",
  type: "fileChange",
  status: "completed",
  changes: [{ path: filename, kind, diff: "" }],
});
const turn = (items: Item[]): Turn => ({
  id: "t",
  prompt: "synthetic",
  attachments: [],
  items,
  status: "completed",
  createdAt: 1,
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-files-"));
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  return {
    root,
    cwd,
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
test("captures exact UTF-8 including empty files, immutable versions and genuine filename", () => {
  const f = fixture();
  try {
    const p = path.join(f.cwd, "card.html");
    fs.writeFileSync(p, "<title>Card</title>一\n");
    const first = captureGeneratedFiles(item(p), f.cwd)[0];
    assert.equal(first.state, "ready");
    assert(Number.isFinite(first.capturedAt));
    assert.equal(generatedArtifact(first)?.updatedAt, first.capturedAt);
    assert.equal(first.bytes, Buffer.byteLength(first.content!));
    assert.equal(generatedArtifact(first)?.filename, "card.html");
    fs.writeFileSync(p, "updated");
    const second = captureGeneratedFiles(item(p, { type: "update" }), f.cwd)[0];
    assert.notEqual(first.digest, second.digest);
    assert.match(first.content!, /一/);
    fs.writeFileSync(p, "");
    assert.equal(captureGeneratedFiles(item(p), f.cwd)[0].content, "");
  } finally {
    f.close();
  }
});
test("rejects outside, symlink escape, binary, invalid UTF-8, large, missing and unsupported files", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "outside.txt"), "outside");
    fs.symlinkSync(
      path.join(f.root, "outside.txt"),
      path.join(f.cwd, "link.txt"),
    );
    fs.writeFileSync(path.join(f.cwd, "binary.txt"), Buffer.from([65, 0]));
    fs.writeFileSync(path.join(f.cwd, "invalid.txt"), Buffer.from([255]));
    fs.writeFileSync(
      path.join(f.cwd, "large.txt"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 65),
    );
    fs.writeFileSync(path.join(f.cwd, "unknown.bin"), "text");
    for (const p of [
      "../outside.txt",
      "link.txt",
      "binary.txt",
      "invalid.txt",
      "missing.txt",
      "unknown.bin",
    ]) {
      const file = captureGeneratedFiles(item(p), f.cwd)[0];
      assert.equal(file.state, "unavailable", p);
      assert.equal(file.content, undefined);
      assert(file.error);
    }
    // A file past the limit is not an error: its card opens a viewer that
    // says it is too large, with the size.
    const large = captureGeneratedFiles(item("large.txt"), f.cwd)[0];
    assert.equal(large.state, "ready");
    assert.equal(large.tooLarge, true);
    assert.equal(large.bytes, 2 * 1024 * 1024 + 1);
    assert.equal(large.content, undefined);
    assert.equal(large.digest, undefined);
    assert.equal(large.error, undefined);
    assert.deepEqual(
      captureGeneratedFiles(
        { ...item("missing.txt"), status: "failed" },
        f.cwd,
      ),
      [],
    );
  } finally {
    f.close();
  }
});
test("snapshots enforce total bytes and file-count limits", () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      path.join(f.cwd, "large.txt"),
      "a".repeat(2 * 1024 * 1024),
    );
    const i = item("large.txt");
    i.changes = Array.from({ length: 5 }, () => i.changes![0]);
    const captured = captureGeneratedFiles(i, f.cwd);
    assert.deepEqual(
      captured.map((f) => f.tooLarge ?? false),
      [false, false, false, false, true],
    );
    assert.deepEqual(
      captured.map((f) => f.content === undefined),
      [false, false, false, false, true],
    );
    fs.writeFileSync(path.join(f.cwd, "empty.txt"), "");
    i.changes = Array.from({ length: 21 }, () => item("empty.txt").changes![0]);
    assert.equal(captureGeneratedFiles(i, f.cwd)[20].state, "unavailable");
  } finally {
    f.close();
  }
});
test("active branch resolution honors updates, moves and deletions without altering history", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.cwd, "a.txt"), "original");
    const a = {
      ...item("a.txt"),
      generatedFiles: captureGeneratedFiles(item("a.txt"), f.cwd),
    };
    fs.writeFileSync(path.join(f.cwd, "b.txt"), "moved");
    const b = item("a.txt", { type: "update", move_path: "b.txt" });
    b.generatedFiles = captureGeneratedFiles(b, f.cwd);
    const files = latestGeneratedFiles([turn([a, b])]);
    assert.equal(files.get(path.join(f.cwd, "a.txt"))?.state, "deleted");
    assert.equal(files.get(path.join(f.cwd, "b.txt"))?.content, "moved");
    assert.equal(
      latestGeneratedFiles([turn([a])]).get(path.join(f.cwd, "a.txt"))?.content,
      "original",
    );
    const deleted = item("b.txt", { type: "delete" });
    deleted.generatedFiles = captureGeneratedFiles(deleted, f.cwd);
    assert.equal(
      latestGeneratedFiles([turn([a, b, deleted])]).get(
        path.join(f.cwd, "b.txt"),
      )?.state,
      "deleted",
    );
  } finally {
    f.close();
  }
});
test("duplicate native completion never rereads modified disk", () => {
  const f = fixture();
  const store = new Store(f.root);
  try {
    const c: Conversation = {
      id: "c",
      title: "Fixture",
      mode: "chat",
      providerId: "default",
      model: "m",
      threadId: "native",
      cwd: f.cwd,
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [{ ...turn([]), status: "inProgress" }],
    };
    store.conversations.push(c);
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    (engine as any).routes.set("native", "c");
    const p = path.join(f.cwd, "a.txt");
    fs.writeFileSync(p, "first");
    const event = {
      method: "item/completed",
      params: { threadId: "native", turnId: "t", item: item(p) },
    };
    (engine as any).notification(event);
    fs.writeFileSync(p, "second");
    (engine as any).notification(event);
    assert.equal(c.turns[0].items[0].generatedFiles?.[0].content, "first");
  } finally {
    store.flush();
    f.close();
  }
});
test("file UI differentiates running, declined, stopped, failed and opens only ready snapshots", () => {
  const render = (i: Item) =>
    renderToStaticMarkup(
      createElement(FileChangeView, { item: i, onArtifact() {} }),
    );
  assert.match(
    render({ ...item("a.html"), status: "inProgress" }),
    /Creating a file/,
  );
  assert.match(
    render({ ...item("a.html"), status: "declined" }),
    /File changes declined/,
  );
  assert.match(
    render({ ...item("a.html"), status: "failed" }),
    /File changes failed/,
  );
  assert.match(
    render({ ...item("a.html"), lifecycleStatus: "interrupted" }),
    /File changes stopped/,
  );
  assert.match(render(item("a.html")), /disabled/);
});

test("legacy artifact age uses its selected source turn without rewriting historical snapshots", () => {
  const file = {
    id: "legacy",
    name: "a.html",
    path: "/synthetic/a.html",
    language: "html",
    operation: "create" as const,
    state: "ready" as const,
    content: "a",
  };
  const original = {
    ...turn([{ ...item(file.path), generatedFiles: [file] }]),
    createdAt: 100,
  };
  const updated = {
    ...turn([
      {
        ...item(file.path),
        generatedFiles: [{ ...file, id: "revision", content: "b" }],
      },
    ]),
    createdAt: 200,
  };
  assert.equal(
    latestGeneratedFiles([original]).get(file.path)?.capturedAt,
    100,
  );
  assert.equal(
    latestGeneratedFiles([original, updated]).get(file.path)?.capturedAt,
    200,
  );
  assert.equal("capturedAt" in file, false);
});
