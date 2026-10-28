import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackgroundHistory } from "../../electron/conversations/background-history";
test("cleared Finished entries survive restart only in their signed-in profile", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-history-a-")),
    b = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-history-b-"));
  try {
    const history = new BackgroundHistory(a);
    assert.deepEqual(history.clear(["conversation:turn"]), [
      "conversation:turn",
    ]);
    assert.deepEqual(new BackgroundHistory(a).list(), ["conversation:turn"]);
    assert.deepEqual(new BackgroundHistory(b).list(), []);
    assert.deepEqual(history.clear(["conversation:turn"]), [
      "conversation:turn",
    ]);
    const file = path.join(a, "background-history.json");
    fs.writeFileSync(file, "{broken");
    assert.throws(() => new BackgroundHistory(a), /cannot be read/);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});
