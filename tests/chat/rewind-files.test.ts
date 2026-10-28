import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { restoreFiles, reverseDiff } from "../../electron/engine/rewind-files";
import { rewindChanges, rewindPreview } from "../../shared/rewind-files";
import type { Turn } from "../../shared/types";

const edit = ["@@ -1,3 +1,4 @@", " a", "-b", "+B", "+B2", " c"].join("\n");

test("an edit's diff is undone in reverse, and refused once the lines moved on", () => {
  assert.equal(reverseDiff("a\nB\nB2\nc\n", edit), "a\nb\nc\n");
  // Shifted by a line added above: still found nearby.
  assert.equal(reverseDiff("z\na\nB\nB2\nc\n", edit), "z\na\nb\nc\n");
  assert.equal(reverseDiff("a\nX\nc\n", edit), undefined);
});

test("restoring undoes Claude's edits newest first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-"));
  try {
    fs.writeFileSync(path.join(root, "app.js"), "a\nB\nB2\nc\n");
    fs.writeFileSync(path.join(root, "new.js"), "made\n");
    fs.writeFileSync(path.join(root, "changed.js"), "edited by hand\n");
    const turns = [
      {
        id: "t1",
        items: [
          {
            id: "i1",
            type: "fileChange",
            status: "completed",
            changes: [
              { path: "app.js", kind: { type: "update" }, diff: edit },
              { path: "new.js", kind: { type: "add" }, diff: "made\n" },
              { path: "gone.js", kind: { type: "delete" }, diff: "old\n" },
              { path: "changed.js", kind: { type: "add" }, diff: "original\n" },
            ],
          },
          {
            id: "i2",
            type: "fileChange",
            status: "declined",
            changes: [{ path: "x", kind: "add", diff: "x" }],
          },
        ],
      },
    ] as unknown as Turn[];
    const changes = rewindChanges(turns);
    assert.equal(changes.length, 4);
    assert.deepEqual(rewindPreview(changes), {
      filesChanged: ["app.js", "new.js", "gone.js", "changed.js"],
      insertions: 4,
      deletions: 2,
    });
    assert.deepEqual(restoreFiles(changes, root), { restored: 3, skipped: 1 });
    assert.equal(
      fs.readFileSync(path.join(root, "app.js"), "utf8"),
      "a\nb\nc\n",
    );
    assert.equal(fs.existsSync(path.join(root, "new.js")), false);
    assert.equal(fs.readFileSync(path.join(root, "gone.js"), "utf8"), "old\n");
    // Changed since: left as it is.
    assert.equal(
      fs.readFileSync(path.join(root, "changed.js"), "utf8"),
      "edited by hand\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
