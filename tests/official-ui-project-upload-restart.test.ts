import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { reserveProjectUpload, ProjectUploadReceiptError } from "../electron/official-ui/api/project-upload-receipts";

const workerIndex = process.argv.indexOf("--receipt-worker");
if (workerIndex !== -1) {
  const [root, id, operation] = process.argv.slice(workerIndex + 1);
  const ctx = {
    account: () => ({ id: "restart-fixture" }),
    stateDirectory: () => root,
    sessionIdentity: () => "fixture-activation",
    isCurrent: () => true,
  };
  try {
    const receipt = await reserveProjectUpload(ctx as never, id, "a".repeat(64));
    if (operation === "confirm") await receipt.confirm();
    process.stdout.write(JSON.stringify({ fresh: receipt.fresh }));
  } catch (error) {
    if (!(error instanceof ProjectUploadReceiptError)) throw error;
    process.stdout.write(JSON.stringify({ status: error.status }));
  }
} else {
  test("project upload receipts survive real process restart without replaying pending or confirmed uploads", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-upload-restart-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const run = (id: string, operation: string) => JSON.parse(execFileSync(process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), "--receipt-worker", root, id, operation],
      { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }));
    assert.deepEqual(run("pending", "reserve"), { fresh: true });
    assert.deepEqual(run("pending", "reserve"), { status: 409 });
    assert.deepEqual(run("completed", "confirm"), { fresh: true });
    assert.deepEqual(run("completed", "reserve"), { fresh: false });
    assert.deepEqual(run("new-upload", "confirm"), { fresh: true });
  });
}
