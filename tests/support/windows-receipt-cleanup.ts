import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

/** Delete only fresh synthetic receipt keys belonging to this test's temp root. */
export function syntheticWindowsReceiptCleanup(
  root: string,
  owners: string[],
): () => void {
  if (process.platform !== "win32") return () => {};
  const temp = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(path.resolve(root).toLowerCase().startsWith(temp.toLowerCase()));
  const keys = owners.map((owner) => {
    const scope = createHash("sha256")
      .update(JSON.stringify(["windows-rest-v1", owner]))
      .digest("hex");
    return `HKCU\\Software\\Claudex\\OfficialRestReceipts\\${scope}`;
  });
  for (const key of keys)
    assert.notEqual(
      spawnSync("reg.exe", ["query", key], { windowsHide: true }).status,
      0,
      "Synthetic registry key already exists",
    );
  return () => {
    for (const key of keys) {
      const query = spawnSync("reg.exe", ["query", key], { windowsHide: true });
      if (query.status === 0)
        assert.equal(
          spawnSync("reg.exe", ["delete", key, "/f"], { windowsHide: true })
            .status,
          0,
          "Synthetic registry cleanup failed",
        );
    }
  };
}
