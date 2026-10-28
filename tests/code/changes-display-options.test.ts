import test from "node:test";
import assert from "node:assert/strict";
import {
  hideWhitespaceChanges,
  parseUnifiedDiff,
} from "../../src/diff/diff-model";
import { changedFileList } from "../../src/changes/turn-changes";

const diff = (body: string, path = "a.ts") =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;

test("Hide whitespace changes turns whitespace-only edits into context", () => {
  const [file] = parseUnifiedDiff(
    diff(
      "@@ -1,4 +1,4 @@\n keep\n-  indented();\n+    indented();\n-old();\n+new();\n end\n",
    ),
  );
  assert.equal(file.additions, 2);
  const shown = hideWhitespaceChanges(file)!;
  assert.deepEqual(
    shown.hunks[0].lines.map((line) => [line.kind, line.text.trim()]),
    [
      ["context", "keep"],
      ["context", "indented();"],
      ["del", "old();"],
      ["add", "new();"],
      ["context", "end"],
    ],
  );
  assert.equal(shown.additions, 1);
  assert.equal(shown.deletions, 1);
  // The new side's text and numbers are kept for the paired line.
  assert.deepEqual(shown.hunks[0].lines[1], {
    kind: "context",
    oldNo: 2,
    newNo: 2,
    text: "    indented();",
  });
});

test("a file, or a hunk, with only whitespace changes drops out", () => {
  const files = parseUnifiedDiff(
    diff("@@ -1,2 +1,2 @@\n-a  b\n+a b\n c\n") +
      diff(
        "@@ -1,2 +1,2 @@\n-a\n+b\n z\n@@ -20,2 +20,2 @@\n-x  y\n+x y\n w\n",
        "b.ts",
      ),
  );
  const shown = files.flatMap((file) => hideWhitespaceChanges(file) ?? []);
  assert.deepEqual(
    shown.map((file) => [file.path, file.hunks.length]),
    [["b.ts", 1]],
  );
  // A new file keeps its lines whatever they hold.
  const [added] = parseUnifiedDiff(
    "diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+ \n+x\n",
  );
  assert.equal(hideWhitespaceChanges(added)?.additions, 2);
});

test("without folders the changed files are one list by path", () => {
  const file = (path: string) => ({
    path,
    status: "modified" as const,
    hunks: [],
    additions: 2,
    deletions: 1,
  });
  const list = changedFileList(
    [file("/work/app/src/b.ts"), file("/work/app/a.ts"), file("/else/c.ts")],
    "/work/app",
  );
  assert.deepEqual(
    list.map((node) => [node.name, node.path, node.children.length]),
    [
      ["/else/c.ts", "/else/c.ts", 0],
      ["a.ts", "/work/app/a.ts", 0],
      ["src/b.ts", "/work/app/src/b.ts", 0],
    ],
  );
});
