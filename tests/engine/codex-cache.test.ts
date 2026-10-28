import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  cachePressure,
  codexCacheRoot,
  prepareCodexCache,
  pruneCodexCache,
  pruneIdleSpaceCaches,
} from "../../electron/engine/codex-cache";
import { validateSpec } from "../../runner/src/sandbox/driver";
import { chatSandboxSpec } from "../../runner/src/sandbox/sandbox-setup";
import { pluginCacheLease } from "../../runner/src/sandbox/plugin-cache";
import { buildOciSpec } from "../../runner/src/sandbox/runsc-oci";

test("spaces share repository, SHA and sync-lock in a sandbox-visible directory", (context) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cache-"));
  context.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const first = path.join(profile, "spaces", "first");
  const second = path.join(profile, "spaces", "second");
  const legacy = path.join(first, "codex-home", ".tmp");
  fs.mkdirSync(path.join(legacy, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "plugins", "manifest"), "cached");
  const shared = prepareCodexCache(profile, first);
  const duplicate = path.join(second, "codex-home", ".tmp", "plugins");
  fs.mkdirSync(duplicate, { recursive: true });
  fs.writeFileSync(path.join(duplicate, "duplicate"), "regenerable");
  assert.equal(prepareCodexCache(profile, second), shared);
  assert.equal(fs.existsSync(path.join(duplicate, "duplicate")), false);
  assert.equal(prepareCodexCache(profile, first), shared);
  for (const name of ["plugins.sha", "plugins.sync.lock"]) {
    fs.writeFileSync(path.join(first, "codex-home", ".tmp", name), name);
    assert.equal(
      fs.readFileSync(path.join(second, "codex-home", ".tmp", name), "utf8"),
      name,
    );
  }
  assert.equal(
    fs.readFileSync(path.join(shared, "plugins", "manifest"), "utf8"),
    "cached",
  );
  const spec = chatSandboxSpec({
    userId: 138,
    storeRoot: second,
    codexCache: shared,
    stateRoot: profile,
    codexBinary: process.execPath,
  });
  validateSpec(spec);
  assert.ok(
    spec.mounts.some((mount) => mount.host === shared && mount.writable),
  );
  pruneCodexCache(profile, first);
  assert.equal(fs.existsSync(path.join(first, "codex-home", ".tmp")), false);
  assert.equal(
    fs.readFileSync(
      path.join(second, "codex-home", ".tmp", "plugins.sha"),
      "utf8",
    ),
    "plugins.sha",
  );
  prepareCodexCache(profile, first);
  assert.equal(
    fs.realpathSync(path.join(first, "codex-home", ".tmp")),
    fs.realpathSync(codexCacheRoot(profile)),
  );
});

test("housekeeping removes only stopped spaces' temporary caches, never user data or symlink targets", (context) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-prune-"));
  context.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  for (const name of ["active", "idle"]) {
    const root = path.join(profile, "spaces", name);
    for (const directory of [
      "codex-home/.tmp/plugins",
      "codex-home/plugins",
      "codex-home/sessions",
      "workspace",
    ])
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    for (const file of [
      "codex-home/.tmp/plugins/cache",
      "codex-home/plugins/installed",
      "codex-home/sessions/chat",
      "workspace/user-file",
    ])
      fs.writeFileSync(path.join(root, file), "keep");
  }
  const outside = path.join(profile, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep"), "keep");
  fs.symlinkSync(outside, path.join(profile, "spaces", "linked"), "dir");
  fs.symlinkSync(
    outside,
    path.join(profile, "spaces", "idle", "codex-home", ".tmp", "link"),
    "dir",
  );
  pruneIdleSpaceCaches(profile, new Set(["active"]));
  assert.equal(
    fs.existsSync(
      path.join(profile, "spaces/active/codex-home/.tmp/plugins/cache"),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(profile, "spaces/idle/codex-home/.tmp")),
    false,
  );
  for (const file of [
    "codex-home/plugins/installed",
    "codex-home/sessions/chat",
    "workspace/user-file",
  ])
    assert.equal(
      fs.readFileSync(path.join(profile, "spaces/idle", file), "utf8"),
      "keep",
    );
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "keep");
  assert.throws(() =>
    prepareCodexCache(profile, path.join(profile, "spaces/linked")),
  );
  assert.throws(() => prepareCodexCache(profile, path.dirname(profile)));
});

test("cache pressure starts at 85 percent, including quotas smaller than the host disk", () => {
  assert.equal(cachePressure(84, 100), false);
  assert.equal(cachePressure(85, 100), true);
  assert.equal(cachePressure(100, 100), true);
  assert.equal(cachePressure(1, 0), false);
});

test("different users never share a marketplace directory", (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-users-cache-"));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const first = path.join(base, "138");
  const second = path.join(base, "139");
  const firstCache = prepareCodexCache(
    first,
    path.join(first, "spaces", "same"),
  );
  const secondCache = prepareCodexCache(
    second,
    path.join(second, "spaces", "same"),
  );
  assert.notEqual(firstCache, secondCache);
  fs.writeFileSync(path.join(firstCache, "plugins.sha"), "user-138");
  assert.equal(fs.existsSync(path.join(secondCache, "plugins.sha")), false);
});

test("gVisor has one host cache writer; other spaces retain writable plugin install scratch", (context) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-lease-"));
  context.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const cache = prepareCodexCache(profile, profile);
  const state = path.join(profile, "private-state");
  const first = pluginCacheLease(state, cache);
  const second = pluginCacheLease(state, cache);
  assert.equal(first.writable, true);
  assert.equal(second.writable, false);
  second.release();
  assert.equal(pluginCacheLease(state, cache).writable, false);
  const spec = chatSandboxSpec({
    userId: 138,
    codexBinary: process.execPath,
    storeRoot: profile,
    stateRoot: state,
    codexCache: cache,
  });
  const built = buildOciSpec({
    spec,
    args: [],
    engineEnv: { CODEX_HOME: path.join(profile, "codex-home") },
    rootfs: profile,
    image: {
      format: "claudex-sandbox-image/1",
      version: "test",
      arch: "x86_64",
      codexVersion: "0.144.1",
      codex: "/bin/codex",
      codexSha256: "a".repeat(64),
      node: "/bin/node",
      pathDirs: [],
    },
    launch: 1,
    ports: [],
    uid: 1000,
    gid: 1000,
    cacheReader: true,
  });
  const mounts = built.config.mounts;
  assert.ok(
    mounts.find((mount) => mount.source === cache)?.options?.includes("rw"),
  );
  assert.ok(
    mounts
      .find((mount) => mount.source === path.join(cache, "plugins.sync.lock"))
      ?.options?.includes("ro"),
  );
  first.release();
  const next = pluginCacheLease(state, cache);
  assert.equal(next.writable, true);
  next.release();
  const lock = path.join(
    state,
    fs.readdirSync(state).find((name) => name.startsWith("plugin-cache-")) ??
      "unused",
  );
  assert.equal(fs.existsSync(lock), false);
  const stale = path.join(
    state,
    `plugin-cache-${createHash("sha256").update(cache).digest("hex")}.lock`,
  );
  fs.writeFileSync(stale, "");
  fs.utimesSync(stale, new Date(0), new Date(0));
  const recovered = pluginCacheLease(state, cache);
  assert.equal(recovered.writable, true);
  recovered.release();
});
