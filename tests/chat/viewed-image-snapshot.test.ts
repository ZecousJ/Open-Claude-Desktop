import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GeneratedBlobs } from "../../electron/artifacts/generated-blobs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("a viewed picture is snapshotted only inside the task's folder (R-0873)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-viewed-"));
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  fs.mkdirSync(work);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(work, "a.png"), png);
  fs.writeFileSync(path.join(other, "b.png"), png);
  const blobs = new GeneratedBlobs(path.join(root, "profile"));
  const snapshot = blobs.snapshotViewedImage(path.join(work, "a.png"), [work]);
  assert.equal(snapshot?.mime, "image/png");
  assert.throws(
    () => blobs.snapshotViewedImage(path.join(other, "b.png"), [work]),
    /outside/,
  );
  assert.equal(
    blobs.snapshotViewedImage(path.join(work, "gone.png"), [work]),
    null,
  );
});
