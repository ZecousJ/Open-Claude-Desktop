import test from "node:test";
import assert from "node:assert/strict";
import {
  knowledgeRefuses,
  sortKnowledgeDrop,
} from "../../src/collections/projects/knowledge-drop";
import { dropZoneAt, registerDropZone } from "../../src/composer/drop-zones";

const knowledge = {
  files: [],
  bytes: 0,
  limit: 100,
  fileLimit: 40,
};

test("a drag of pictures only is refused over the knowledge area", () => {
  const items = (types: string[]) =>
    types.map((type) => ({ kind: "file" as const, type }));
  assert.equal(knowledgeRefuses(items(["image/png"]), knowledge), true);
  assert.equal(
    knowledgeRefuses(items(["image/png", "text/plain"]), knowledge),
    false,
  );
  // Markdown and source files often have no MIME type during a drag.
  assert.equal(knowledgeRefuses(items([""]), knowledge), false);
  assert.equal(knowledgeRefuses(items(["application/pdf"]), knowledge), false);
  // A full project refuses everything.
  assert.equal(
    knowledgeRefuses(items(["text/plain"]), { ...knowledge, bytes: 100 }),
    true,
  );
});

test("a drop is sorted: unreadable, too large and over capacity are reported once", () => {
  const file = (name: string, size: number, type = "") => ({
    name,
    size,
    type,
  });
  const { accepted, notices } = sortKnowledgeDrop(
    [
      file("notes.md", 10),
      file("photo.png", 10, "image/png"),
      file("big.txt", 50),
      file("Folder", 0),
      file("a.pdf", 30, "application/pdf"),
      file("b.txt", 30),
      file("c.txt", 30),
      file("d.txt", 30),
    ],
    knowledge,
  );
  assert.deepEqual(
    accepted.map((f) => f.name),
    ["notes.md", "a.pdf", "b.txt", "c.txt"],
  );
  assert.equal(notices.length, 4);
  assert.ok(notices.some((n) => n.includes("photo.png")));
  assert.ok(notices.some((n) => n.includes("big.txt is too large")));
  assert.ok(notices.some((n) => n.startsWith("Folders can't")));
  assert.ok(notices.some((n) => n.startsWith("Project knowledge at capacity")));
});

type FakeNode = {
  parent?: FakeNode;
  contains(other: FakeNode | null): boolean;
};

const fakeNode = (parent?: FakeNode): FakeNode => ({
  parent,
  contains(other) {
    let current: FakeNode | undefined | null = other;
    while (current) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  },
});

test("the innermost registered zone takes a drag", () => {
  // dropZoneAt only needs Node-like targets.
  const scope = globalThis as { Node?: unknown };
  const saved = scope.Node;
  scope.Node = Object;
  try {
    const outer = fakeNode();
    const inner = fakeNode(outer);
    const leaf = fakeNode(inner);
    const offOuter = registerDropZone(() => outer as never);
    const offInner = registerDropZone(() => inner as never);
    assert.equal(dropZoneAt(leaf as never), inner);
    offInner();
    assert.equal(dropZoneAt(leaf as never), outer);
    offOuter();
    assert.equal(dropZoneAt(leaf as never), null);
  } finally {
    scope.Node = saved;
  }
});
