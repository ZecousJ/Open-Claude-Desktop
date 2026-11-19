import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { classifyTccFolderKind } from "../electron/official-ui/native/tcc-folder";

test("official folder classification matches protected roots without matching sibling prefixes", () => {
  const home = path.resolve("/tmp/claudex-tcc-test");
  assert.equal(classifyTccFolderKind(path.join(home, "Desktop", "work"), home), "desktop");
  assert.equal(classifyTccFolderKind(path.join(home, "Documents"), home), "documents");
  assert.equal(classifyTccFolderKind(path.join(home, "Downloads", "one"), home), "downloads");
  assert.equal(classifyTccFolderKind(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "one"), home), "icloud");
  assert.equal(classifyTccFolderKind(path.join(home, "Library", "CloudStorage", "one"), home), "cloudStorage");
  assert.equal(classifyTccFolderKind(path.join(home, "Desktop-other"), home), null);
  assert.equal(classifyTccFolderKind(path.join(home, "Desktop", "..", "elsewhere"), home), null);
});
