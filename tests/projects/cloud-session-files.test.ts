import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useElectronShim } from "../runner/runner-core-support.test.ts";

useElectronShim();
const { registerWorkspaceHandlers } =
  await import("../../electron/ipc/workspace");

// The Files pane of a cloud Code session: the runner reads the session's own
// folder, never saves there.
function handlers(conversation: object) {
  const map = new Map<string, (...args: any[]) => any>();
  registerWorkspaceHandlers((name, handler) => map.set(name, handler), {
    store: { conversation: () => conversation },
    selectedFolders: new Set(),
    selectedAttachments: new Map(),
    allowedFolder() {},
    policy: () => ({}),
  } as unknown as Parameters<typeof registerWorkspaceHandlers>[1]);
  return map;
}

test("a cloud session's folder lists and reads on the runner; saving there is refused", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cloud-files-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src", "main.ts"), "export const a = 1;\n");
  const map = handlers({
    id: "c",
    mode: "code",
    cwd,
    environment: { kind: "space", spaceId: "s1" },
  });
  const listed = await map.get("listProjectFolder")!("c", "");
  assert.deepEqual(
    listed.entries.map((entry: { name: string }) => entry.name),
    ["src"],
  );
  const file = await map.get("readProjectFile")!("c", "src/main.ts");
  assert.equal(file.content, "export const a = 1;\n");
  const found = await map.get("searchProjectFiles")!("c", "const a");
  assert.equal(found.matches[0].path, "src/main.ts");
  await assert.rejects(
    async () =>
      map.get("writeProjectFile")!("c", "src/main.ts", "x", "0".repeat(64)),
    /files aren't on this computer/,
  );
  // An SSH session's folder is on its host, not here.
  const ssh = handlers({
    id: "c",
    mode: "code",
    cwd,
    environment: { kind: "ssh", hostId: "h" },
  });
  await assert.rejects(
    async () => ssh.get("listProjectFolder")!("c", ""),
    /files aren't on this computer/,
  );
});
