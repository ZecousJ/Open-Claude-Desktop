/**
 * The Changes panel's git in a cloud session (runner/src/sandbox-git.ts):
 * queries go through the sandbox launcher, never past the workspace, and the
 * host-side file reads never follow links. The launcher is replaced by the
 * system git here; the sandbox itself is exercised by the Linux bwrap tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workingTreeChanges } from "../../electron/git/working-tree";
import {
  noWorkingTree,
  sandboxWorkingTree,
} from "../../runner/src/sandbox-git";
import type {
  SandboxDriver,
  SandboxSpec,
} from "../../runner/src/sandbox/driver";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-git-"));
const storeRoot = path.join(root, "profile");
const workspace = path.join(storeRoot, "workspace");
fs.mkdirSync(path.join(workspace, "code", "s1"), { recursive: true });
const session = path.join(workspace, "code", "s1");
const git = (...args: string[]) =>
  execFileSync("git", ["-C", session, ...args], { encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.email", "a@example.test");
git("config", "user.name", "A");
fs.writeFileSync(path.join(session, "a.txt"), "one\n");
git("add", ".");
git("commit", "-q", "-m", "first");
fs.writeFileSync(path.join(session, "a.txt"), "one\ntwo\n");
fs.writeFileSync(path.join(session, "new.txt"), "x\ny\nz\n");

const specs: SandboxSpec[] = [];
const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
const driver = {
  name: "bwrap",
  isolation: "namespaces",
  async check() {
    return { ok: true, driver: "bwrap", problems: [], warnings: [] };
  },
  prepare(spec: SandboxSpec) {
    specs.push(spec);
    return {
      binary: "/run/launcher",
      specPath: "/run/spec.json",
      spec,
      dispose() {},
    };
  },
} as SandboxDriver;
const host = sandboxWorkingTree({
  driver,
  userId: 7,
  storeRoot,
  stateRoot: path.join(root, "sandboxes"),
  // The launcher is the system git: same arguments, no sandbox.
  run: async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    const done = spawnSync("git", args, {
      encoding: "utf8",
      env: { ...process.env, ...options.env },
    });
    return { stdout: done.stdout, code: done.status ?? -1 };
  },
});

test("the diff is read through the launcher of a sandbox that cannot write the folder", async () => {
  const changes = await workingTreeChanges(session, 3, host);
  assert.equal(changes.state, "ready");
  assert.equal(changes.base, "main");
  assert.match(changes.diff, /\+two/);
  assert.match(changes.diff, /new\.txt/);
  assert.equal(changes.lineCounts["new.txt"], 3);
  assert.ok(calls.length > 3);
  for (const call of calls) {
    assert.equal(call.file, "/run/launcher");
    assert.deepEqual(call.args.slice(0, 2), ["-C", call.args[1]]);
    assert.ok(call.args.includes("core.fsmonitor=false"));
    assert.equal(call.env.CODEX_HOME, path.join(storeRoot, "codex-home"));
  }
  // One sandbox, prepared once: git, the workspace read-only, no network.
  assert.equal(specs.length, 1);
  const [spec] = specs;
  assert.equal(spec.id, "git-7");
  assert.equal(spec.codexBinary, "/usr/bin/git");
  assert.equal(spec.egress, undefined);
  assert.deepEqual(
    spec.mounts.map((m) => [m.host, m.writable]),
    [
      [workspace, false],
      [path.join(storeRoot, "codex-home"), true],
    ],
  );
  assert.equal(spec.env?.GIT_CONFIG_NOSYSTEM, "1");
});

test("folders outside the session workspace are refused", async () => {
  for (const cwd of [root, "/etc", path.join(workspace, "..", "codex-home")])
    await assert.rejects(host.git(cwd, ["status"]), /outside the session/);
  assert.deepEqual(await workingTreeChanges("/etc", 3, host).catch(() => 0), {
    state: "not-git",
    diff: "",
    lineCounts: {},
  });
});

test("file reads stay inside the workspace and never follow links", async () => {
  fs.writeFileSync(path.join(root, "secret.txt"), "a\nb\n");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(session, "link.txt"));
  const entries = await host.entries(session, [
    "a.txt",
    "link.txt",
    "../../../../secret.txt",
  ]);
  assert.equal(entries.get("a.txt")?.kind, "file");
  assert.equal(entries.get("link.txt")?.kind, "symlink");
  assert.equal(entries.has("../../../../secret.txt"), false);
  assert.deepEqual(
    await host.lineCounts(
      session,
      ["a.txt", "link.txt", "../../../../secret.txt"],
      1000,
    ),
    { "a.txt": 2 },
  );
});

test("without a sandbox nothing is read", async () => {
  assert.deepEqual(await workingTreeChanges(session, 3, noWorkingTree), {
    state: "not-git",
    diff: "",
    lineCounts: {},
  });
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
