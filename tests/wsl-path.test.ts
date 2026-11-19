import assert from "node:assert/strict";
import test from "node:test";
import { wslFolderPath } from "../electron/wsl/paths";
import { sameEnvironment } from "../electron/engine/engine-types";

test("the Windows picker maps only WSL network paths to Linux workspaces", () => {
  assert.deepEqual(
    wslFolderPath("\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\my repo"),
    {
      distro: "Ubuntu-24.04",
      cwd: "/tmp/my repo",
    },
  );
  assert.deepEqual(wslFolderPath("\\\\wsl$\\Ubuntu-24.04\\"), {
    distro: "Ubuntu-24.04",
    cwd: "/",
  });
  assert.equal(wslFolderPath("\\\\fileserver\\Ubuntu-24.04\\tmp"), undefined);
});

test("WSL distro identity does not match SSH or the Windows workspace", () => {
  const ubuntu = { kind: "wsl", distro: "Ubuntu-24.04" } as const;
  assert.equal(
    sameEnvironment(ubuntu, { kind: "wsl", distro: "ubuntu-24.04" }),
    true,
  );
  assert.equal(
    sameEnvironment(ubuntu, { kind: "wsl", distro: "Debian" }),
    false,
  );
  assert.equal(
    sameEnvironment(ubuntu, { kind: "ssh", hostId: "Ubuntu-24.04" }),
    false,
  );
  assert.equal(sameEnvironment(ubuntu, { kind: "local" }), false);
});
