import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fileKind,
  filesByKind,
  isLargeDiff,
} from "../../src/changes/file-kinds";

test("files sort into the original's sections", () => {
  assert.equal(fileKind("src/app.ts"), "source");
  assert.equal(fileKind("package-lock.json"), "generated");
  assert.equal(fileKind("web/yarn.lock"), "generated");
  assert.equal(fileKind("api/gen/client.ts"), "generated");
  assert.equal(fileKind("proto/user.pb.go"), "generated");
  assert.equal(fileKind("public/app.min.js"), "generated");
  assert.equal(fileKind("dist/index.js"), "generated");
  assert.equal(fileKind("BUILD.bazel"), "build");
  assert.equal(fileKind("rules/defs.bzl"), "build");
  assert.equal(fileKind("src/app.test.ts"), "test");
  assert.equal(fileKind("src/__tests__/app.ts"), "test");
  assert.equal(fileKind("tests/app.ts"), "test");
  assert.equal(fileKind("pkg/test_util.py"), "test");
  assert.equal(fileKind("ui/Button.stories.tsx"), "test");
  // Generated wins over test.
  assert.equal(fileKind("tests/__generated__/x.ts"), "generated");
});

test("grouping keeps order and large diffs are spotted", () => {
  const groups = filesByKind([
    { path: "b.ts" },
    { path: "a.test.ts" },
    { path: "a.ts" },
  ]);
  assert.deepEqual(
    groups.source.map((f) => f.path),
    ["b.ts", "a.ts"],
  );
  assert.deepEqual(
    groups.test.map((f) => f.path),
    ["a.test.ts"],
  );
  assert.equal(isLargeDiff([{ additions: 9000, deletions: 900 }]), false);
  assert.equal(isLargeDiff([{ additions: 9000, deletions: 1001 }]), true);
});

test("side by side pairs a change's removed and added lines", async () => {
  const { splitRows } = await import("../../src/diff/diff-model");
  const line = (kind: "context" | "add" | "del", text: string) => ({
    kind,
    text,
  });
  const rows = splitRows([
    line("context", "a"),
    line("del", "b"),
    line("del", "c"),
    line("add", "B"),
    line("context", "d"),
    line("add", "e"),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]),
    [
      ["a", "a"],
      ["b", "B"],
      ["c", null],
      ["d", "d"],
      [null, "e"],
    ],
  );
});

test("file headers name binary, whitespace-only, mode and rename changes", async () => {
  const { parseUnifiedDiff, whitespaceOnly } =
    await import("../../src/diff/diff-model");
  const { fileBadge, renamedFrom } =
    await import("../../src/changes/ChangedFileSection");
  const [mode] = parseUnifiedDiff(
    "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n",
  );
  assert.equal(fileBadge(mode), "Made executable");
  const [space] = parseUnifiedDiff(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-if (x){\n+if (x) {\n",
  );
  assert.ok(whitespaceOnly(space));
  assert.equal(fileBadge(space), "Whitespace only");
  const [moved] = parseUnifiedDiff(
    "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts\n",
  );
  assert.equal(renamedFrom(moved), "old.ts");
  const [away] = parseUnifiedDiff(
    "diff --git a/lib/x.ts b/src/x.ts\nrename from lib/x.ts\nrename to src/x.ts\n",
  );
  assert.equal(renamedFrom(away), "lib/x.ts");
});
