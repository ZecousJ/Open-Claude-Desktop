import test from "node:test";
import assert from "node:assert/strict";
import { planUpdate, updateKindFor } from "../../shared/app-update";
import {
  linuxApplyCommand,
  linuxApplyScript,
} from "../../electron/updates/scripts";
import { installTarget } from "../../electron/updates/apply";

const sha = "a".repeat(64);
const release = (url: string) => ({
  latestVersion: "0.0.28",
  downloadUrl: url,
  sha256: sha,
});

test("a Linux copy updates only from the package it was installed with", () => {
  assert.equal(
    updateKindFor("linux", "x64"),
    undefined,
    "unknown install: no updates",
  );
  assert.equal(updateKindFor("linux", "x64", "deb"), "linux-deb");
  assert.equal(updateKindFor("linux", "arm64", "rpm"), "linux-rpm");
  assert.equal(updateKindFor("linux", "ia32", "deb"), undefined);
  const plan = planUpdate(
    release("https://dl.example.com/claudex_0.0.28_amd64.deb"),
    "0.0.27",
    "linux",
    "x64",
    "deb",
  );
  assert.equal(plan.action, "download");
  assert.equal(
    plan.action === "download" && plan.fileName,
    "Claudex-0.0.28-linux-x64.deb",
  );
  assert.deepEqual(
    planUpdate(
      release("https://dl.example.com/claudex-0.0.28.x86_64.rpm"),
      "0.0.27",
      "linux",
      "x64",
      "deb",
    ),
    { action: "none", reason: "wrong-file-type", version: "0.0.28" },
  );
  const tar = planUpdate(
    release("https://dl.example.com/Claudex-0.0.28-linux-arm64.tar.gz"),
    "0.0.27",
    "linux",
    "arm64",
    "tar",
  );
  assert.equal(tar.action === "download" && tar.kind, "linux-tar");
});

test("the Linux helper gets its values as arguments and installs through pkexec", () => {
  const command = linuxApplyCommand("/u/updates/install-update.sh", {
    pid: 42,
    file: "/u/updates/x.deb",
    target: "/opt/Claudex",
    relaunch: true,
    resultFile: "/u/updates/apply-result.json",
    version: "0.0.28",
    stagedRecord: "/u/updates/staged.json",
    kind: "linux-deb",
    exePath: "/opt/Claudex/claudex",
  });
  assert.equal(command.command, "/bin/sh");
  assert.deepEqual(command.args, [
    "/u/updates/install-update.sh",
    "42",
    "/u/updates/x.deb",
    "linux-deb",
    "1",
    "/u/updates/apply-result.json",
    "0.0.28",
    "/opt/Claudex",
    "/opt/Claudex/claudex",
    "/u/updates/staged.json",
  ]);
  for (const step of [
    "pkexec dpkg -i",
    "pkexec rpm -U",
    "pkexec /bin/sh -c",
    "chmod 4755",
  ])
    assert.ok(linuxApplyScript.includes(step), step);
  assert.equal(installTarget("/opt/claudex/claudex", "linux"), "/opt/claudex");
});
