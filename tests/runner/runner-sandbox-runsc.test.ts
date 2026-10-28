// W-GVISOR: gVisor (runsc) driver, quotas and workspace snapshots.
//
// Runs under `npm test` (tsx) on any platform: the OCI spec, the commands,
// quota bookkeeping and the snapshot format are tested with stand-ins (a fake
// `runsc`, a fake S3 server, fake cgroup files). The "real gVisor" tests run
// only on Linux as root with a sandbox image rootfs:
//   CLAUDEX_TEST_RUNSC_ROOTFS=<unpacked claudex-sandbox rootfs>
//   CLAUDEX_TEST_RUNSC_ENGINE=runsc|containerd   (default runsc)
//   CLAUDEX_TEST_RUNSC_CONFIG=<runsc.toml>        (containerd engine)
//   CLAUDEX_TEST_LOOP=1                           (also test the loop disk quota)
// Erasable TypeScript only, so plain Node can run this file too.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  SANDBOX_CLASSES,
  SandboxSpecError,
  clampNetworkLevel,
  validateSpec,
} from "../../runner/src/sandbox/driver.ts";
import {
  SANDBOX_CODEX_HOME,
  SANDBOX_WORKSPACE,
  listenUnixToUnix,
  workspaceSandboxSpec,
} from "../../runner/src/sandbox/sandbox-setup.ts";
import type { SandboxSpec } from "../../runner/src/sandbox/driver.ts";
import { RunscDriver } from "../../runner/src/sandbox/runsc.ts";
import { launch } from "../../runner/src/sandbox/runsc-launch.ts";
import {
  checkRunsc,
  checkRuntimeConfig,
} from "../../runner/src/sandbox/runsc-check.ts";
import {
  chownTree,
  cleanupCommands,
  execCommand,
  runCommand,
} from "../../runner/src/sandbox/runsc-commands.ts";
import {
  CONTAINER_PREFIX,
  buildOciSpec,
  codexSandboxModeFor,
  containerId,
  readImageManifest,
  runscSocketPathFits,
} from "../../runner/src/sandbox/runsc-oci.ts";
import type { SandboxImage } from "../../runner/src/sandbox/runsc-oci.ts";
import {
  LoopQuota,
  SoftQuota,
  XfsProjectQuota,
  canAdmit,
  cgroupDir,
  checkCgroups,
  measureDisk,
  ociResources,
  readCgroupUsage,
  readMounts,
} from "../../runner/src/sandbox/quota.ts";
import type { CommandRunner } from "../../runner/src/sandbox/quota.ts";
import {
  LocalSnapshotStore,
  SnapshotService,
  createSnapshot,
  restoreSnapshot,
  openVerified,
} from "../../runner/src/sandbox/snapshot.ts";
import {
  SnapshotError,
  checkKey,
} from "../../runner/src/sandbox/snapshot-common.ts";
import {
  extractTar,
  safeMemberName,
  tarHeader,
} from "../../runner/src/sandbox/snapshot-tar.ts";
import {
  S3SnapshotStore,
  signS3,
} from "../../runner/src/sandbox/snapshot-s3.ts";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const runscModule = path.join(repo, "runner/bin/sandbox-runsc");
// Short base: Unix socket paths are limited to about 104 bytes on macOS.
const base = fs.mkdtempSync(
  path.join(
    fs.realpathSync(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir()),
    "rsc-",
  ),
);
after(() => fs.rmSync(base, { recursive: true, force: true }));
let counter = 0;
function dir(name: string) {
  const d = path.join(base, `${name}${++counter}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const CODEX_SHA = "a".repeat(64);

/** A fake unpacked image: just the manifest (and codex/node files for check()). */
function fakeRootfs(extra: Partial<SandboxImage> = {}) {
  const rootfs = dir("img");
  const image: SandboxImage = {
    format: "claudex-sandbox-image/1",
    version: "test",
    arch: "x86_64",
    codexVersion: "0.144.1",
    codex: "/opt/claudex/codex/bin/codex",
    codexSha256: CODEX_SHA,
    node: "/usr/local/bin/node",
    pathDirs: ["/opt/claudex/codex/codex-path"],
    ...extra,
  };
  fs.mkdirSync(path.join(rootfs, "opt/claudex"), { recursive: true });
  fs.writeFileSync(
    path.join(rootfs, "opt/claudex/image.json"),
    JSON.stringify(image),
  );
  return { rootfs, image };
}

/** A code sandbox with the production layout. */
function codeLayout(
  overrides: Partial<Parameters<typeof workspaceSandboxSpec>[0]> = {},
) {
  const dataDir = path.join(dir("data"), "sbx");
  const stateRoot = dir("st");
  const spec = workspaceSandboxSpec({
    id: "code-1",
    kind: "code",
    dataDir,
    stateRoot,
    ...overrides,
  });
  return { dataDir, stateRoot, spec };
}

const GATEWAY_ARG = (port: number) =>
  `model_providers.claudex={ name = "Claudex gateway", base_url = "http://127.0.0.1:${port}/v1", env_key = "CLAUDEX_GATEWAY_TOKEN", wire_api = "responses" }`;

function engineEnv(codexHome: string): NodeJS.ProcessEnv {
  return {
    PATH: "/opt/runner/bin:/usr/bin",
    HOME: "/var/lib/claudex-runner",
    CODEX_HOME: codexHome,
    CLAUDEX_GATEWAY_TOKEN: "loopback-capability",
    OPENAI_API_KEY: "sk-should-not-leak",
    CLAUDEX_RUNNER_TOKEN: "runner-link-secret",
    R2_SECRET_ACCESS_KEY: "r2-secret",
    NODE_OPTIONS: "--require /evil.js",
    LANG: "en_US.UTF-8",
  };
}

function resolvedOptions(o: Record<string, string | undefined>) {
  // runCommand/cleanupCommands take the resolved options; build them the way
  // the driver does, through a prepared spec.
  const { rootfs } = fakeRootfs();
  const { spec } = codeLayout();
  const prepared = new RunscDriver({ rootfs, ...(o as object) }).prepare(spec);
  return prepared.spec;
}

// ---------------------------------------------------------------------------

describe("layout, classes and image", () => {
  test("production layout mounts data at fixed paths with class limits", () => {
    const { dataDir, spec } = codeLayout();
    assert.deepEqual(
      spec.mounts.map((m) => [m.host, m.sandbox, m.writable]),
      [
        [path.join(dataDir, "workspace"), SANDBOX_WORKSPACE, true],
        [path.join(dataDir, "codex-home"), SANDBOX_CODEX_HOME, true],
      ],
    );
    assert.equal(spec.cwd, "/workspace");
    assert.deepEqual(spec.limits, SANDBOX_CLASSES.code);
    assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
    validateSpec(spec);
  });

  test("class table follows W-RUN 4.1", () => {
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(SANDBOX_CLASSES).map(([k, v]) => [
          k,
          [v.cpus, v.memoryMb, v.diskMb, v.pids],
        ]),
      ),
      {
        chat: [0.5, 512, 2048, 256],
        cowork: [1, 1024, 5120, 512],
        code: [2, 2048, 10240, 1024],
      },
    );
  });

  test("gVisor may be given full network access", () => {
    assert.equal(clampNetworkLevel("full", "gvisor"), "full");
    assert.equal(clampNetworkLevel("full", "namespaces"), "trusted");
  });

  test("image manifest is validated", () => {
    const { rootfs, image } = fakeRootfs();
    assert.deepEqual(readImageManifest(rootfs), image);
    for (const bad of [
      { format: "other" },
      { codex: "relative/codex" },
      { node: "/usr/../etc/node" },
      { codexSha256: "nothex" },
      { pathDirs: ["ok", "/fine"] },
      { env: { "lower-case": "x" } },
      { env: { OK: 1 } },
      { env: ["PATH=/x"] },
    ]) {
      const f = fakeRootfs(bad as Partial<SandboxImage>);
      assert.throws(() => readImageManifest(f.rootfs), SandboxSpecError);
    }
    assert.throws(
      () => readImageManifest(dir("empty")),
      /no readable manifest/,
    );
  });

  test("codex sandbox modes under gVisor keep network on for workspace-write", () => {
    assert.deepEqual(codexSandboxModeFor("auto"), {
      sandbox: "workspace-write",
      sandboxWorkspaceWrite: { networkAccess: true },
    });
    assert.deepEqual(codexSandboxModeFor("bypass"), {
      sandbox: "danger-full-access",
    });
  });
});

describe("OCI spec", () => {
  function built(
    extra: Partial<SandboxSpec> = {},
    ports = [41234],
    imageExtra: Partial<SandboxImage> = {},
  ) {
    const { image, rootfs } = fakeRootfs(imageExtra);
    const { dataDir, spec } = codeLayout();
    const egressDir = dir("eg");
    const s: SandboxSpec = {
      ...spec,
      codexBinary: image.codex,
      node: image.node,
      egress: { socket: path.join(egressDir, "e.sock") },
      ...extra,
    };
    const out = buildOciSpec({
      spec: s,
      args: ["app-server", "--listen", "stdio://", "-c", GATEWAY_ARG(41234)],
      engineEnv: engineEnv(path.join(dataDir, "codex-home")),
      rootfs,
      image,
      launch: 77,
      ports,
      uid: 1000,
      gid: 1000,
      cgroupsPath: "/claudex/claudex-code-1",
    });
    return { ...out, dataDir, rootfs, spec: s };
  }

  test("the image's environment reaches the sandbox under its own", () => {
    const { config } = built({}, [41234], {
      env: { PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright", PATH: "/evil" },
    });
    const env = new Map(
      config.process.env.map((e) => [
        e.slice(0, e.indexOf("=")),
        e.slice(e.indexOf("=") + 1),
      ]),
    );
    assert.equal(env.get("PLAYWRIGHT_BROWSERS_PATH"), "/opt/playwright");
    assert.notEqual(env.get("PATH"), "/evil");
  });

  test("non-root, no capabilities, no new privileges, read-only image root", () => {
    const { config, rootfs } = built();
    assert.deepEqual(config.process.user, {
      uid: 1000,
      gid: 1000,
      additionalGids: [],
    });
    assert.equal(config.process.noNewPrivileges, true);
    for (const set of Object.values(config.process.capabilities))
      assert.deepEqual(set, []);
    assert.deepEqual(config.root, { path: rootfs, readonly: true });
    assert.equal(config.hostname, "sandbox");
    const ns = config.linux.namespaces.map((n) => n.type).sort();
    assert.deepEqual(ns, ["ipc", "mount", "network", "pid", "uts"]);
    assert.ok(config.linux.maskedPaths.includes("/proc/kcore"));
  });

  test("the only host paths are the data, the launch sockets and identity files", () => {
    const { config, dataDir, spec } = built();
    const launchDir = path.join(spec.stateDir, "run", "77");
    const binds = config.mounts.filter((m) => m.type === "bind");
    for (const b of binds)
      assert.ok(
        b.source.startsWith(dataDir + "/") ||
          b.source.startsWith(launchDir + "/"),
        b.source,
      );
    const by = Object.fromEntries(binds.map((b) => [b.destination, b]));
    assert.deepEqual(by["/workspace"].options, [
      "rbind",
      "rw",
      "nosuid",
      "nodev",
    ]);
    assert.deepEqual(by["/codex-home"].options, [
      "rbind",
      "rw",
      "nosuid",
      "nodev",
    ]);
    assert.equal(by["/run/claudex/fwd"].source, path.join(launchDir, "fwd"));
    assert.ok(by["/run/claudex/fwd"].options!.includes("ro"));
    assert.ok(by["/etc/passwd"].options!.includes("ro"));
    // The runner-private spec and state never appear.
    assert.ok(
      !JSON.stringify(config.mounts).includes(
        path.join(spec.stateDir, "spec.json"),
      ),
    );
    // /tmp is a sized tmpfs (counts against memory).
    const tmp = config.mounts.find((m) => m.destination === "/tmp")!;
    assert.equal(tmp.type, "tmpfs");
    assert.ok(tmp.options!.includes("size=512m"));
  });

  test("environment: allowlist only, CODEX_HOME mapped, proxy through the bridge", () => {
    const { config, env, forwards } = built();
    const names = config.process.env.map((e) => e.split("=")[0]);
    for (const k of [
      "OPENAI_API_KEY",
      "CLAUDEX_RUNNER_TOKEN",
      "R2_SECRET_ACCESS_KEY",
      "NODE_OPTIONS",
    ])
      assert.ok(!names.includes(k), k);
    assert.equal(env.CODEX_HOME, "/codex-home");
    assert.equal(env.HOME, "/codex-home/home");
    assert.equal(env.CLAUDEX_GATEWAY_TOKEN, "loopback-capability");
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:3128");
    assert.ok(
      env.PATH.startsWith("/opt/claudex/codex/codex-path:/usr/local/bin:"),
    );
    assert.deepEqual(forwards, [
      { port: 41234, socket: "/run/claudex/fwd/p41234.sock" },
      { port: 3128, socket: "/run/claudex/fwd/egress.sock" },
    ]);
    // Bridge first, then the image's codex with Engine's arguments.
    assert.equal(config.process.args[0], "/usr/local/bin/node");
    const bridge = JSON.parse(
      config.process.env
        .find((e) => e.startsWith("CLAUDEX_SANDBOX_BRIDGE="))!
        .slice("CLAUDEX_SANDBOX_BRIDGE=".length),
    );
    assert.equal(bridge.argv[0], "/opt/claudex/codex/bin/codex");
    assert.equal(bridge.argv[1], "app-server");
    assert.equal(config.process.cwd, "/workspace");
  });

  test("without ports or egress codex runs directly", () => {
    const { config } = built({ egress: undefined }, []);
    assert.equal(config.process.args[0], "/opt/claudex/codex/bin/codex");
    assert.ok(!config.mounts.some((m) => m.destination === "/run/claudex/fwd"));
  });

  test("resources: memory without swap, pids, CPU quota, cgroup path", () => {
    const { config } = built();
    assert.deepEqual(config.linux.resources, {
      memory: { limit: 2048 * 1048576, swap: 2048 * 1048576 },
      pids: { limit: 1024 },
      cpu: { quota: 200000, period: 100000 },
    });
    assert.equal(config.linux.cgroupsPath, "/claudex/claudex-code-1");
  });
});

describe("commands", () => {
  test("containerd: ctr run with the runsc shim and the spec file, nothing secret on argv", () => {
    const spec = resolvedOptions({
      engine: "containerd",
      runtimeConfig: "/etc/claudex-runner/runsc.toml",
      containerdAddress: "/run/containerd/containerd.sock",
    });
    // Resolve through the driver's own parser via the exported helpers.
    const o = (spec.options ?? {}) as Record<string, string>;
    assert.equal(o.engine, "containerd");
    assert.equal(o.driver, "runsc");
    const cmd = runCommand(
      {
        engine: "containerd",
        rootfs: o.rootfs,
        ctr: "ctr",
        containerdAddress: o.containerdAddress,
        namespace: "claudex",
        runtime: "io.containerd.runsc.v1",
        runtimeConfig: o.runtimeConfig,
        runsc: "runsc",
        runscRoot: "/run/claudex-runsc",
        platform: "systrap",
        runscFlags: [],
        ignoreCgroups: false,
        cgroupParent: "/claudex",
        uid: 1000,
        gid: 1000,
        sudo: false,
        command: undefined,
      },
      "/state/run/1/bundle",
      "claudex-code-1",
    );
    assert.deepEqual(cmd, [
      "ctr",
      "--address",
      "/run/containerd/containerd.sock",
      "--namespace",
      "claudex",
      "run",
      "--rm",
      "--runtime",
      "io.containerd.runsc.v1",
      "--runtime-config-path",
      "/etc/claudex-runner/runsc.toml",
      "--config",
      "/state/run/1/bundle/config.json",
      "claudex-code-1",
    ]);
  });

  const runscOpts = {
    engine: "runsc" as const,
    rootfs: "/img",
    ctr: "ctr",
    containerdAddress: undefined,
    namespace: "claudex",
    runtime: "io.containerd.runsc.v1",
    runtimeConfig: undefined,
    runsc: "/usr/local/bin/runsc",
    runscRoot: "/run/claudex-runsc",
    platform: "systrap",
    runscFlags: ["--overlay2=none"],
    ignoreCgroups: false,
    cgroupParent: "/claudex",
    uid: 1000,
    gid: 1000,
    sudo: false,
    command: undefined,
  };

  test("runsc through sudo: the runner stays unprivileged", () => {
    const o = { ...runscOpts, sudo: true };
    assert.deepEqual(runCommand(o, "/b", "claudex-x").slice(0, 4), [
      "sudo",
      "-n",
      "/usr/local/bin/runsc",
      "--root",
    ]);
    assert.deepEqual(cleanupCommands(o, "claudex-x")[0]!.slice(0, 3), [
      "sudo",
      "-n",
      "/usr/local/bin/runsc",
    ]);
    assert.deepEqual(execCommand(o, "claudex-x", ["git"], "/w").slice(0, 2), [
      "sudo",
      "-n",
    ]);
  });

  test("runsc: no network, host sockets only, cgroups kept", () => {
    assert.deepEqual(runCommand(runscOpts, "/b", "claudex-x"), [
      "/usr/local/bin/runsc",
      "--root",
      "/run/claudex-runsc",
      "--platform",
      "systrap",
      "--network=none",
      "--host-uds=open",
      "--overlay2=none",
      "run",
      "--bundle",
      "/b",
      "claudex-x",
    ]);
    assert.deepEqual(cleanupCommands(runscOpts, "claudex-x"), [
      [
        "/usr/local/bin/runsc",
        "--root",
        "/run/claudex-runsc",
        "delete",
        "--force",
        "claudex-x",
      ],
    ]);
    const ex = execCommand(
      runscOpts,
      "claudex-x",
      ["git", "status"],
      "/workspace",
    );
    assert.deepEqual(ex, [
      "/usr/local/bin/runsc",
      "--root",
      "/run/claudex-runsc",
      "exec",
      "--user",
      "1000:1000",
      "--cwd",
      "/workspace",
      "claudex-x",
      "git",
      "status",
    ]);
  });

  test("containerd cleanup and exec", () => {
    const o = { ...runscOpts, engine: "containerd" as const };
    const cl = cleanupCommands(o, "claudex-x");
    assert.deepEqual(
      cl.map((c) => c.slice(3, 5)),
      [
        ["task", "kill"],
        ["task", "delete"],
        ["container", "delete"],
      ],
    );
    const ex = execCommand(o, "claudex-x", ["ls"], "/workspace");
    assert.deepEqual(ex.slice(0, 6), [
      "ctr",
      "--namespace",
      "claudex",
      "task",
      "exec",
      "--exec-id",
    ]);
    assert.deepEqual(ex.slice(-6), [
      "--user",
      "1000:1000",
      "--cwd",
      "/workspace",
      "claudex-x",
      "ls",
    ]);
  });

  test("container ids carry the driver prefix", () => {
    assert.equal(containerId({ id: "chat-42" }), `${CONTAINER_PREFIX}chat-42`);
  });

  test("shipped runsc.toml keeps the network off and host sockets open", () => {
    const toml = fs.readFileSync(
      path.join(repo, "deploy/claudex-runner/image/runsc.toml"),
      "utf8",
    );
    assert.deepEqual(checkRuntimeConfig(toml), []);
    assert.equal(
      checkRuntimeConfig(
        toml.replace('network = "none"', 'network = "sandbox"'),
      ).length,
      1,
    );
    assert.equal(checkRuntimeConfig("").length, 2);
  });
});

describe("driver", () => {
  test("prepare: codex and node from the image, private spec, launcher runs sandbox-runsc", () => {
    const { rootfs } = fakeRootfs();
    const { spec } = codeLayout();
    const prepared = new RunscDriver({ rootfs, engine: "runsc" }).prepare({
      ...spec,
      codexBinary: "/host/should/be/replaced",
    });
    assert.equal(prepared.spec.codexBinary, "/opt/claudex/codex/bin/codex");
    assert.equal(prepared.spec.node, "/usr/local/bin/node");
    assert.equal(prepared.spec.options?.driver, "runsc");
    assert.equal(prepared.spec.options?.engine, "runsc");
    assert.equal(fs.statSync(prepared.specPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(prepared.binary).mode & 0o777, 0o700);
    const launcher = fs.readFileSync(prepared.binary, "utf8");
    assert.ok(launcher.includes(runscModule), launcher);
    const uid = process.getuid!();
    assert.equal(prepared.spec.options?.uid, String(uid === 0 ? 1000 : uid));
    prepared.dispose();
    assert.ok(!fs.existsSync(prepared.binary));
  });

  test("prepare: another program of the image runs instead of codex (git)", () => {
    const { rootfs } = fakeRootfs();
    fs.mkdirSync(path.join(rootfs, "usr/bin"), { recursive: true });
    fs.writeFileSync(path.join(rootfs, "usr/bin/git"), "");
    const { spec } = codeLayout();
    const git = new RunscDriver({ rootfs, sudo: true }).prepare({
      ...spec,
      codexBinary: "/usr/bin/git",
    });
    assert.equal(git.spec.options?.command, JSON.stringify(["/usr/bin/git"]));
    assert.equal(git.spec.options?.sudo, "1");
    // A host path the image doesn't have is codex's place: the image's codex.
    const codex = new RunscDriver({ rootfs }).prepare({
      ...spec,
      codexBinary: "/opt/claudex-runner/node_modules/.bin/codex",
    });
    assert.equal(codex.spec.options?.command, undefined);
    assert.equal(codex.spec.options?.sudo, undefined);
  });

  test("prepare rejects bad options and too-long state paths", () => {
    const { rootfs } = fakeRootfs();
    const { spec } = codeLayout();
    assert.throws(
      () =>
        new RunscDriver({ rootfs, runscFlags: ["network=host"] }).prepare(spec),
      /runscFlags/,
    );
    assert.throws(
      () => new RunscDriver({ rootfs: "relative" }).prepare(spec),
      SandboxSpecError,
    );
    const long = codeLayout({ stateRoot: dir("x".repeat(60)) });
    assert.equal(runscSocketPathFits(long.spec.stateDir), false);
    assert.throws(
      () => new RunscDriver({ rootfs }).prepare(long.spec),
      /too long/,
    );
  });

  test("check reports a non-Linux host or a broken image", async () => {
    const { rootfs } = fakeRootfs();
    const r = await checkRunsc({
      rootfs,
      engine: "runsc",
      runsc: "/nonexistent/runsc",
    });
    assert.equal(r.ok, false);
    if (process.platform !== "linux")
      assert.deepEqual(r.problems, ["The runsc driver needs Linux."]);
    else assert.ok(r.problems.some((p) => /runsc|codex/.test(p)));
  });

  test("chownTree never follows links", () => {
    const d = dir("own");
    fs.writeFileSync(path.join(d, "f"), "x");
    fs.symlinkSync("/etc/passwd", path.join(d, "l"));
    const uid = process.getuid!();
    const gid = process.getgid!();
    chownTree(d, uid, gid);
    assert.equal(chownTree(d, uid, gid), 0);
    assert.equal(fs.statSync("/etc/passwd").uid, 0, "link target untouched");
  });

  test(
    "openVerified refuses a path redirected through a swapped directory",
    { skip: process.platform !== "linux" },
    () => {
      // A running sandbox could replace `ws/a` with a link between our readdir
      // and open; the descriptor check must catch the redirected file.
      const base = fs.realpathSync(dir("swap"));
      const outside = path.join(base, "host");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "secret"), "host secret");
      fs.mkdirSync(path.join(base, "ws"));
      fs.symlinkSync(outside, path.join(base, "ws", "a"));
      const p = path.join(base, "ws", "a", "secret");
      assert.equal(openVerified(p, p), undefined);
      const fd = openVerified(
        path.join(outside, "secret"),
        path.join(outside, "secret"),
      );
      assert.notEqual(fd, undefined);
      fs.closeSync(fd!);
    },
  );
});

// ---------------------------------------------------------------------------
// End to end with a stand-in runsc

describe("launcher end to end with a stand-in runsc", () => {
  test("stdio passes through, spec and sockets are right, leftovers are cleaned", async () => {
    const { rootfs } = fakeRootfs();
    const { dataDir, spec } = codeLayout();
    const log = path.join(dir("log"), "calls.jsonl");
    const fake = path.join(dir("bin"), "runsc");
    // Records every call; on `run` it checks the bundle and the sockets, then
    // echoes stdin and exits 7.
    fs.writeFileSync(
      fake,
      `#!${process.execPath}
const fs = require("fs"), path = require("path"), net = require("net");
const argv = process.argv.slice(2);
const entry = { argv };
if (argv.includes("run")) {
  const bundle = argv[argv.indexOf("--bundle") + 1];
  const cfg = JSON.parse(fs.readFileSync(path.join(bundle, "config.json"), "utf8"));
  entry.cfgMode = (fs.statSync(path.join(bundle, "config.json")).mode & 0o777).toString(8);
  entry.env = cfg.process.env;
  entry.args = cfg.process.args;
  const fwd = cfg.mounts.find((m) => m.destination === "/run/claudex/fwd").source;
  entry.sockets = fs.readdirSync(fwd).sort().map((f) => [f, (fs.statSync(path.join(fwd, f)).mode & 0o777).toString(8)]);
  entry.passwd = fs.readFileSync(cfg.mounts.find((m) => m.destination === "/etc/passwd").source, "utf8");
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
  // Talk to the gateway through the host side of the bridge.
  const port = Number(entry.sockets.find(([f]) => f.startsWith("p"))[0].slice(1, -5));
  const c = net.connect(path.join(fwd, "p" + port + ".sock"), () => c.write("GET /v1/ping HTTP/1.0\\r\\n\\r\\n"));
  let got = "";
  c.on("data", (d) => (got += d));
  c.on("close", () => {
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => { process.stdout.write("echo:" + input + "|" + got.split("\\r\\n\\r\\n")[1]); process.exit(7); });
  });
} else {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
}
`,
      { mode: 0o755 },
    );
    const gateway = http.createServer((req, res) => res.end(`gw${req.url}`));
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
    const gport = (gateway.address() as net.AddressInfo).port;
    const egressSock = path.join(dir("eg"), "e.sock");
    const egress = net.createServer((c) => c.end("proxy"));
    await new Promise<void>((r) => egress.listen(egressSock, () => r()));
    const prepared = new RunscDriver({
      rootfs,
      engine: "runsc",
      runsc: fake,
      node: process.execPath,
    }).prepare({ ...spec, egress: { socket: egressSock } });
    // A sandbox-made symlink where Engine writes config.toml is removed.
    const victim = path.join(dir("victim"), "runner.env");
    fs.writeFileSync(victim, "runner file");
    fs.symlinkSync(victim, path.join(dataDir, "codex-home", "config.toml"));
    const r = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        prepared.binary,
        ["app-server", "--listen", "stdio://", "-c", GATEWAY_ARG(gport)],
        { env: engineEnv(path.join(dataDir, "codex-home")), stdio: "pipe" },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end("hello");
    });
    gateway.close();
    egress.close();
    assert.equal(r.code, 7, r.stderr);
    assert.equal(r.stdout, "echo:hello|gw/v1/ping");
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // delete --force before (leftovers), run, delete --force after.
    assert.deepEqual(
      calls.map(
        (c) => c.argv.filter((a: string) => ["run", "delete"].includes(a))[0],
      ),
      ["delete", "run", "delete"],
    );
    const runCall = calls[1];
    assert.ok(!runCall.argv.join(" ").includes("loopback-capability"));
    assert.ok(
      runCall.env.includes("CLAUDEX_GATEWAY_TOKEN=loopback-capability"),
    );
    assert.ok(
      !runCall.env.some((e: string) => e.startsWith("OPENAI_API_KEY=")),
    );
    assert.equal(runCall.cfgMode, "600");
    assert.deepEqual(runCall.sockets, [
      ["egress.sock", "666"],
      [`p${gport}.sock`, "666"],
    ]);
    assert.match(
      runCall.passwd,
      /^sandbox:x:\d+:\d+:Claudex sandbox:\/codex-home\/home:/m,
    );
    assert.ok(runCall.argv.includes("--network=none"));
    assert.ok(runCall.argv.includes("--host-uds=open"));
    // Trap removed, target untouched, launch dir gone, HOME created.
    assert.throws(() =>
      fs.lstatSync(path.join(dataDir, "codex-home", "config.toml")),
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "runner file");
    assert.deepEqual(fs.readdirSync(path.join(spec.stateDir, "run")), []);
    assert.ok(
      fs.statSync(path.join(dataDir, "codex-home", "home")).isDirectory(),
    );
    prepared.dispose();
  });

  test("a spec for another driver is refused", async () => {
    const { spec } = codeLayout();
    fs.mkdirSync(spec.stateDir, { recursive: true, mode: 0o700 });
    const specPath = path.join(spec.stateDir, "spec.json");
    fs.writeFileSync(
      specPath,
      JSON.stringify({ ...spec, options: { driver: "bwrap" } }),
      {
        mode: 0o600,
      },
    );
    const r = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        runscModule,
        "--spec",
        specPath,
        "--",
        "x",
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 126);
    assert.match(r.stderr, /not for the runsc driver/);
  });

  test("unix relay pipes to the target socket", async () => {
    const d = dir("relay");
    const target = path.join(d, "t.sock");
    const srv = net.createServer((c) => c.on("data", (x) => c.end("re:" + x)));
    await new Promise<void>((r) => srv.listen(target, () => r()));
    const relay = await listenUnixToUnix(path.join(d, "r.sock"), target);
    const got = await new Promise<string>((resolve) => {
      const c = net.connect(path.join(d, "r.sock"), () => c.write("ping"));
      let s = "";
      c.on("data", (x) => (s += x));
      c.on("close", () => resolve(s));
    });
    relay.close();
    srv.close();
    assert.equal(got, "re:ping");
  });
});

// ---------------------------------------------------------------------------
// Quotas

describe("quotas", () => {
  test("OCI resources from limits", () => {
    assert.deepEqual(ociResources({ memoryMb: 512, pids: 256, cpus: 0.5 }), {
      memory: { limit: 536870912, swap: 536870912 },
      pids: { limit: 256 },
      cpu: { quota: 50000, period: 100000 },
    });
    assert.deepEqual(ociResources(undefined), {});
  });

  test("cgroup usage and controller checks from cgroup v2 files", () => {
    const root = dir("cg");
    fs.writeFileSync(
      path.join(root, "cgroup.controllers"),
      "cpuset cpu io memory pids\n",
    );
    assert.deepEqual(checkCgroups(root), []);
    fs.writeFileSync(path.join(root, "cgroup.controllers"), "cpu io\n");
    assert.match(checkCgroups(root)[0], /memory, pids/);
    assert.match(checkCgroups(dir("nocg"))[0], /cgroup v2/);
    const cg = cgroupDir("/claudex/claudex-code-1", root);
    assert.equal(cg, path.join(root, "claudex/claudex-code-1"));
    assert.equal(cgroupDir("/claudex/../../etc", root), path.join(root, "etc"));
    fs.mkdirSync(cg, { recursive: true });
    fs.writeFileSync(path.join(cg, "memory.current"), "1048576\n");
    fs.writeFileSync(path.join(cg, "memory.peak"), "2097152\n");
    fs.writeFileSync(
      path.join(cg, "memory.events"),
      "low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n",
    );
    fs.writeFileSync(path.join(cg, "pids.current"), "12\n");
    fs.writeFileSync(
      path.join(cg, "cpu.stat"),
      "usage_usec 5000\nuser_usec 4000\n",
    );
    assert.deepEqual(readCgroupUsage(cg), {
      memoryBytes: 1048576,
      memoryPeakBytes: 2097152,
      memoryMaxEvents: 3,
      oomKills: 1,
      pids: 12,
      cpuUsec: 5000,
    });
  });

  test("admission keeps 10% of memory free and checks disk", () => {
    const cap = {
      memTotalBytes: 10 * 1024 ** 3,
      memAvailableBytes: 3 * 1024 ** 3,
      diskFreeBytes: 20 * 1024 ** 3,
      cpus: 10,
    };
    assert.equal(canAdmit(SANDBOX_CLASSES.code, cap).ok, true);
    assert.equal(canAdmit({ memoryMb: 2500 }, cap).ok, false);
    assert.match(canAdmit({ diskMb: 30 * 1024 }, cap).reason!, /disk/);
  });

  test("measureDisk counts allocated bytes and does not follow links", () => {
    const d = dir("du");
    fs.writeFileSync(path.join(d, "a"), Buffer.alloc(100_000, 1));
    fs.mkdirSync(path.join(d, "sub"));
    fs.writeFileSync(path.join(d, "sub", "b"), Buffer.alloc(50_000, 1));
    const big = dir("outside");
    fs.writeFileSync(path.join(big, "huge"), Buffer.alloc(3_000_000, 1));
    fs.symlinkSync(big, path.join(d, "link"));
    const u = measureDisk(d);
    assert.ok(u.bytes >= 150_000 && u.bytes < 1_000_000, String(u.bytes));
    assert.equal(u.entries, 5);
  });

  test("soft quota reports and flags excess", () => {
    const q = new SoftQuota();
    const d = path.join(dir("soft"), "v");
    const s0 = q.prepare(d, 16);
    assert.equal(s0.exceeded, false);
    fs.writeFileSync(path.join(d, "big"), Buffer.alloc(17 * 1024 * 1024, 1));
    assert.equal(q.status(d, 16).exceeded, true);
    assert.throws(() => q.prepare("relative", 16));
    assert.throws(() => q.prepare(d, 1.5));
    q.release(d, { destroy: true });
    assert.ok(!fs.existsSync(d));
  });

  function recorder(): CommandRunner & { calls: string[][] } {
    const calls: string[][] = [];
    return { calls, run: (argv) => (calls.push(argv), "") };
  }

  test("loop quota: sparse image, ext4 owned by the sandbox user, nosuid/nodev mount", () => {
    const runner = recorder();
    const mounted = new Set<string>();
    const d = path.join(dir("loop"), "sbx");
    const imagesDir = dir("images");
    const q = new LoopQuota({
      imagesDir,
      runner: {
        run(argv) {
          runner.calls.push(argv);
          if (argv[0] === "mount") mounted.add(argv[argv.length - 1]);
          if (argv[0] === "umount") mounted.delete(argv[1]);
          return "";
        },
      },
      owner: { uid: 1000, gid: 1001 },
      mounts: () =>
        [...mounted].map((m) => ({
          mountPoint: m,
          source: "/dev/loop7",
          fsType: "ext4",
        })),
    });
    q.prepare(d, 64);
    const image = q.imageFor(d);
    assert.equal(fs.statSync(image).size, 64 * 1024 * 1024);
    assert.equal(fs.statSync(image).mode & 0o777, 0o600);
    assert.deepEqual(runner.calls, [
      ["mkfs.ext4", "-q", "-F", "-m", "0", "-E", "root_owner=1000:1001", image],
      ["mount", "-t", "ext4", "-o", "loop,nosuid,nodev,noatime", image, d],
    ]);
    // Idempotent; growing resizes online.
    runner.calls.length = 0;
    q.prepare(d, 64);
    assert.deepEqual(runner.calls, []);
    q.prepare(d, 128);
    assert.deepEqual(runner.calls, [
      ["losetup", "-c", "/dev/loop7"],
      ["resize2fs", "/dev/loop7"],
    ]);
    runner.calls.length = 0;
    q.release(d, { destroy: true });
    assert.deepEqual(runner.calls, [["umount", d]]);
    assert.ok(!fs.existsSync(image));
  });

  test("loop quota refuses to hide existing data under a new volume", () => {
    const d = dir("loopfull");
    fs.writeFileSync(path.join(d, "x"), "x");
    const q = new LoopQuota({
      imagesDir: dir("images"),
      runner: recorder(),
      mounts: () => [],
    });
    assert.throws(() => q.prepare(d, 64), /not empty/);
  });

  test("xfs project quota", () => {
    const runner = recorder();
    const d = path.join(dir("xfs"), "sbx");
    const root = path.dirname(d);
    const q = new XfsProjectQuota({
      runner,
      mounts: () => [
        { mountPoint: "/", source: "/dev/sda1", fsType: "ext4" },
        { mountPoint: root, source: "/dev/sdb1", fsType: "xfs" },
      ],
    });
    const id = q.projectId(d);
    assert.ok(id >= 100000 && id < 2 ** 31);
    q.prepare(d, 1024);
    assert.deepEqual(runner.calls, [
      ["xfs_quota", "-x", "-c", `project -s -p ${d} ${id}`, root],
      ["xfs_quota", "-x", "-c", `limit -p bhard=1024m ${id}`, root],
    ]);
    const q2 = new XfsProjectQuota({
      runner,
      mounts: () => [{ mountPoint: "/", source: "/dev/sda1", fsType: "ext4" }],
    });
    assert.throws(() => q2.prepare(d, 64), /not on an XFS/);
    assert.throws(() => q.prepare(path.join(root, "a b"), 64), /spaces/);
  });

  test("mountinfo parsing", () => {
    const m = readMounts(
      "36 35 98:0 / /var/lib/claudex-runner/data/code\\0401 rw,noatime - ext4 /dev/loop3 rw\n" +
        "37 35 8:1 / / rw - xfs /dev/sda1 rw,prjquota\n",
    );
    assert.deepEqual(m, [
      {
        mountPoint: "/var/lib/claudex-runner/data/code 1",
        source: "/dev/loop3",
        fsType: "ext4",
      },
      { mountPoint: "/", source: "/dev/sda1", fsType: "xfs" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Snapshots

function populate(dataDir: string) {
  const ws = path.join(dataDir, "workspace");
  const ch = path.join(dataDir, "codex-home");
  fs.mkdirSync(path.join(ws, "src", "deep"), { recursive: true });
  fs.mkdirSync(path.join(ch, "sessions", "2026", "09"), { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# hello\n");
  fs.writeFileSync(path.join(ws, "src", "run.sh"), "#!/bin/sh\necho hi\n", {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(ws, "empty"), "");
  const longName = "n".repeat(120) + ".txt";
  fs.writeFileSync(path.join(ws, "src", "deep", longName), "long");
  fs.writeFileSync(path.join(ws, "src", "unicodé-文件.txt"), "utf8");
  fs.writeFileSync(path.join(ws, "bin.dat"), crypto.randomBytes(300_000));
  fs.symlinkSync("src/run.sh", path.join(ws, "link-to-run"));
  fs.symlinkSync("/etc/passwd", path.join(ws, "abs-link"));
  fs.writeFileSync(
    path.join(ch, "sessions", "2026", "09", "rollout-1.jsonl"),
    '{"type":"session_meta"}\n',
  );
  fs.writeFileSync(path.join(ch, "config.toml"), "# host-written, excluded\n");
  fs.mkdirSync(path.join(ch, "tmp"));
  fs.writeFileSync(path.join(ch, "tmp", "x"), "scratch");
  if (process.platform !== "win32")
    spawnSync("mkfifo", [path.join(ws, "pipe")]);
  return { longName };
}

describe("snapshots", () => {
  test("round trip keeps files, modes, links and long names; skips excludes and FIFOs", async () => {
    const src = dir("src");
    const { longName } = populate(src);
    const archive = path.join(dir("arch"), "s.tar.zst");
    const m = await createSnapshot({
      dataDir: src,
      outFile: archive,
      meta: { sandbox: "code-1" },
    });
    assert.equal(m.format, "claudex-snapshot/1");
    assert.equal(m.compressedBytes, fs.statSync(archive).size);
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(m.meta, { sandbox: "code-1" });
    assert.equal(fs.statSync(archive).mode & 0o777, 0o600);
    const dest = dir("dest");
    fs.mkdirSync(path.join(dest, "workspace"));
    fs.writeFileSync(path.join(dest, "workspace", "stale"), "old");
    fs.writeFileSync(path.join(dest, "keep-me"), "outside the roots");
    const r = await restoreSnapshot({
      archive,
      dataDir: dest,
      sha256: m.sha256,
    });
    assert.equal(r.entries, m.entries);
    const ws = path.join(dest, "workspace");
    assert.equal(
      fs.readFileSync(path.join(ws, "README.md"), "utf8"),
      "# hello\n",
    );
    assert.equal(
      fs.statSync(path.join(ws, "src", "run.sh")).mode & 0o777,
      0o755,
    );
    assert.equal(
      fs.readFileSync(path.join(ws, "src", "deep", longName), "utf8"),
      "long",
    );
    assert.equal(
      fs.readFileSync(path.join(ws, "src", "unicodé-文件.txt"), "utf8"),
      "utf8",
    );
    assert.equal(fs.readFileSync(path.join(ws, "empty"), "utf8"), "");
    assert.ok(
      fs
        .readFileSync(path.join(ws, "bin.dat"))
        .equals(fs.readFileSync(path.join(src, "workspace", "bin.dat"))),
    );
    assert.equal(fs.readlinkSync(path.join(ws, "link-to-run")), "src/run.sh");
    assert.equal(fs.readlinkSync(path.join(ws, "abs-link")), "/etc/passwd");
    assert.ok(!fs.existsSync(path.join(ws, "stale")), "old content replaced");
    assert.ok(!fs.existsSync(path.join(ws, "pipe")), "FIFO skipped");
    assert.equal(
      fs.readFileSync(path.join(dest, "keep-me"), "utf8"),
      "outside the roots",
    );
    const ch = path.join(dest, "codex-home");
    assert.ok(
      fs.existsSync(path.join(ch, "sessions", "2026", "09", "rollout-1.jsonl")),
    );
    assert.ok(
      !fs.existsSync(path.join(ch, "config.toml")),
      "config.toml excluded",
    );
    assert.ok(!fs.existsSync(path.join(ch, "tmp")), "tmp excluded");
    assert.deepEqual(
      fs.readdirSync(dest).filter((n) => n.startsWith(".restore-")),
      [],
    );
  });

  test("system tar can list the archive (plain ustar + pax)", async (t) => {
    const src = dir("src");
    populate(src);
    const archive = path.join(dir("arch"), "s.tar.zst");
    await createSnapshot({ dataDir: src, outFile: archive });
    const tarFile = archive.replace(/\.zst$/, "");
    fs.writeFileSync(
      tarFile,
      zlib.zstdDecompressSync(fs.readFileSync(archive)),
    );
    const r = spawnSync("tar", ["-tf", tarFile], { encoding: "utf8" });
    if (r.error) return t.skip("no tar");
    assert.equal(r.status, 0, r.stderr);
    const names = r.stdout.split("\n").filter(Boolean);
    assert.ok(names.includes("workspace/README.md"));
    assert.ok(names.some((n) => n.endsWith("n".repeat(120) + ".txt")));
  });

  test("integrity check rejects a modified archive", async () => {
    const src = dir("src");
    populate(src);
    const archive = path.join(dir("arch"), "s.tar.zst");
    const m = await createSnapshot({ dataDir: src, outFile: archive });
    await assert.rejects(
      restoreSnapshot({ archive, dataDir: dir("d"), sha256: "0".repeat(64) }),
      /integrity/,
    );
    assert.ok(m.sha256);
  });

  test("size and entry limits apply when packing", async () => {
    const src = dir("src");
    populate(src);
    await assert.rejects(
      createSnapshot({
        dataDir: src,
        outFile: path.join(dir("a"), "x"),
        maxBytes: 1000,
      }),
      /larger than the snapshot limit/,
    );
    await assert.rejects(
      createSnapshot({
        dataDir: src,
        outFile: path.join(dir("a"), "x"),
        maxEntries: 3,
      }),
      /too many files/,
    );
  });

  // Hostile archives, built by hand.
  function tarOf(
    entries: Array<{
      name: string;
      type: "file" | "dir" | "symlink";
      data?: string;
      linkname?: string;
      raw?: Buffer[];
    }>,
  ) {
    const parts: Buffer[] = [];
    for (const e of entries) {
      if (e.raw) {
        parts.push(...e.raw);
        continue;
      }
      const data = Buffer.from(e.data ?? "");
      parts.push(
        ...tarHeader({
          name: e.name,
          type: e.type,
          mode: 0o644,
          mtime: 0,
          size: data.length,
          linkname: e.linkname,
        }),
      );
      if (e.type === "file") {
        parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
      }
    }
    parts.push(Buffer.alloc(1024));
    return Buffer.concat(parts);
  }
  async function* once(b: Buffer) {
    // odd chunk sizes to exercise the streaming parser
    for (let i = 0; i < b.length; i += 333) yield b.subarray(i, i + 333);
  }

  test("hostile names are refused", async () => {
    for (const name of [
      "../evil",
      "/etc/evil",
      "workspace/../../evil",
      "other-root/x",
      "workspace/./x",
    ]) {
      const dest = dir("hx");
      await assert.rejects(
        extractTar(once(tarOf([{ name, type: "file", data: "x" }])), dest),
        /Unsafe name/,
        name,
      );
    }
    assert.equal(
      safeMemberName("./workspace/a/", ["workspace"]),
      "workspace/a",
    );
  });

  test("nothing is written through a symlink from the archive", async () => {
    const outside = dir("outside");
    const dest = dir("hl");
    await assert.rejects(
      extractTar(
        once(
          tarOf([
            { name: "workspace", type: "dir" },
            { name: "workspace/esc", type: "symlink", linkname: outside },
            { name: "workspace/esc/pwned", type: "file", data: "x" },
          ]),
        ),
        dest,
      ),
      /conflicting entries/,
    );
    assert.deepEqual(fs.readdirSync(outside), []);
    // A link and a file with the same name.
    await assert.rejects(
      extractTar(
        once(
          tarOf([
            { name: "workspace/a", type: "file", data: "1" },
            { name: "workspace/a", type: "symlink", linkname: outside },
          ]),
        ),
        dir("hl2"),
      ),
      /conflicting entries/,
    );
  });

  test("hard links, truncation, bad checksums and bombs are refused", async () => {
    const hard = tarHeader({
      name: "workspace/h",
      type: "file",
      mode: 0o644,
      mtime: 0,
      size: 0,
    });
    hard[hard.length - 1][156] = "1".charCodeAt(0);
    // fix checksum after changing the type flag
    const h = hard[hard.length - 1];
    h.write("        ", 148, 8, "ascii");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    await assert.rejects(
      extractTar(
        once(tarOf([{ name: "", type: "file", raw: hard }])),
        dir("hk"),
      ),
      /unsupported/,
    );
    const good = tarOf([{ name: "workspace/f", type: "file", data: "hello" }]);
    await assert.rejects(
      extractTar(once(good.subarray(0, 700)), dir("tr")),
      /truncated/,
    );
    const bad = Buffer.from(good);
    bad[10] ^= 0xff;
    await assert.rejects(extractTar(once(bad), dir("ck")), /checksum/);
    const bomb = tarOf([
      { name: "workspace/f", type: "file", data: "x".repeat(5000) },
    ]);
    await assert.rejects(
      extractTar(once(bomb), dir("bb"), { maxBytes: 4096 }),
      /larger than the limit/,
    );
    await assert.rejects(
      extractTar(
        once(
          tarOf(
            Array.from({ length: 10 }, (_, i) => ({
              name: `workspace/f${i}`,
              type: "file" as const,
              data: "",
            })),
          ),
        ),
        dir("en"),
        { maxEntries: 5 },
      ),
      /too many entries/,
    );
  });

  test("keys are relative and dot-free", () => {
    assert.equal(
      checkKey("users/42/code-1/2026-09-26T10-00"),
      "users/42/code-1/2026-09-26T10-00",
    );
    for (const k of ["", "/abs", "a/../b", "a//b", ".hidden", "a/.x", "sp ace"])
      assert.throws(() => checkKey(k), SnapshotError, k);
  });

  test("local store and service: save, load, retention", async () => {
    const src = dir("src");
    populate(src);
    const store = new LocalSnapshotStore(dir("store"));
    const svc = new SnapshotService(store, dir("work"));
    const m = await svc.save("users/42/code-1/s1", src, {
      meta: { image: "test" },
    });
    assert.ok(await store.exists("users/42/code-1/s1.tar.zst"));
    const dest = dir("dest");
    const r = await svc.load("users/42/code-1/s1", dest, { sha256: m.sha256 });
    assert.equal(r.manifest.sha256, m.sha256);
    assert.ok(fs.existsSync(path.join(dest, "workspace", "README.md")));
    await assert.rejects(
      svc.load("users/42/code-1/s1", dir("d2"), { sha256: "f".repeat(64) }),
      /integrity/,
    );
    await assert.rejects(
      svc.load("users/42/code-1/s1", dir("d3"), { roots: ["workspace"] }),
      /unexpected/,
    );
    const old = path.join(store.root, "users/42/code-1/s1.json");
    fs.utimesSync(old, new Date(0), new Date(0));
    assert.deepEqual(store.prune(30 * 86400_000), ["users/42/code-1/s1.json"]);
    await svc.remove("users/42/code-1/s1");
    assert.equal(await store.exists("users/42/code-1/s1.tar.zst"), false);
    await assert.rejects(
      svc.load("users/42/code-1/s1", dir("d4")),
      /not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// S3 / R2

describe("S3-compatible storage", () => {
  test("SigV4 matches the AWS S3 documentation example", () => {
    const { headers, signature } = signS3({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { Range: "bytes=0-9" },
      payloadHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      date: new Date("2013-05-24T00:00:00Z"),
    });
    assert.equal(
      signature,
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    assert.equal(
      headers.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  /** A tiny S3 server: checks every signature, supports PUT/GET/HEAD/DELETE and multipart. */
  async function fakeS3(opts: { failFirst?: boolean } = {}) {
    const objects = new Map<string, Buffer>();
    const uploads = new Map<string, Map<number, Buffer>>();
    const log: string[] = [];
    let failed = !opts.failFirst;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const auth = String(req.headers.authorization ?? "");
        const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1].split(";") ?? [];
        const hdrs: Record<string, string> = {};
        for (const n of signed)
          if (n !== "host") hdrs[n] = String(req.headers[n]);
        const amz = String(req.headers["x-amz-date"]);
        const { headers } = signS3({
          method: req.method!,
          url: `http://${req.headers.host}${req.url}`,
          headers: hdrs,
          payloadHash: String(req.headers["x-amz-content-sha256"]),
          accessKeyId: "AK",
          secretAccessKey: "SECRET",
          region: "auto",
          date: new Date(
            `${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`,
          ),
        });
        const hash = crypto.createHash("sha256").update(body).digest("hex");
        log.push(`${req.method} ${url.pathname}${url.search}`);
        if (
          headers.authorization !== auth ||
          (body.length && hash !== req.headers["x-amz-content-sha256"])
        ) {
          res.statusCode = 403;
          return res.end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
        }
        if (!failed) {
          failed = true;
          res.statusCode = 503;
          return res.end("slow down");
        }
        const key = decodeURIComponent(url.pathname);
        const uploadId = url.searchParams.get("uploadId");
        if (req.method === "POST" && url.searchParams.has("uploads")) {
          const id = `u${uploads.size + 1}`;
          uploads.set(id, new Map());
          return res.end(
            `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
          );
        }
        if (req.method === "PUT" && uploadId) {
          uploads
            .get(uploadId)!
            .set(Number(url.searchParams.get("partNumber")), body);
          res.setHeader("etag", `"e${url.searchParams.get("partNumber")}"`);
          return res.end();
        }
        if (req.method === "POST" && uploadId) {
          const parts = uploads.get(uploadId)!;
          const order = [
            ...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g),
          ].map((m) => Number(m[1]));
          objects.set(key, Buffer.concat(order.map((n) => parts.get(n)!)));
          return res.end("<CompleteMultipartUploadResult/>");
        }
        if (req.method === "PUT") {
          objects.set(key, body);
          return res.end();
        }
        const obj = objects.get(key);
        if (req.method === "DELETE") {
          objects.delete(key);
          res.statusCode = 204;
          return res.end();
        }
        if (!obj) {
          res.statusCode = 404;
          return res.end("<Error><Code>NoSuchKey</Code></Error>");
        }
        if (req.method === "HEAD") return res.end();
        return res.end(obj);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    return { server, objects, log, endpoint: `http://127.0.0.1:${port}` };
  }

  test("put, get, exists, delete with retries; secrets never serialized", async () => {
    const s3 = await fakeS3({ failFirst: true });
    const store = new S3SnapshotStore({
      endpoint: s3.endpoint,
      bucket: "claudex-snapshots",
      accessKeyId: "AK",
      secretAccessKey: "SECRET",
      prefix: "runner-1/",
    });
    assert.ok(!JSON.stringify(store).includes("SECRET"));
    const f = path.join(dir("s3"), "a.bin");
    fs.writeFileSync(f, crypto.randomBytes(1000));
    await store.put("users/42/x (1).tar.zst".replace(/[ ()]/g, "_"), f);
    assert.equal(s3.log[0].startsWith("PUT"), true);
    assert.equal(s3.log.length, 2, "one retry after 503");
    const key = "users/42/x__1_.tar.zst";
    assert.ok(s3.objects.has("/claudex-snapshots/runner-1/" + key));
    assert.equal(await store.exists(key), true);
    const got = path.join(dir("s3g"), "b.bin");
    await store.get(key, got);
    assert.ok(fs.readFileSync(got).equals(fs.readFileSync(f)));
    await store.delete(key);
    assert.equal(await store.exists(key), false);
    await assert.rejects(store.get(key, got), /not found/);
    s3.server.close();
  });

  test("multipart upload above the part size", async () => {
    const s3 = await fakeS3();
    const store = new S3SnapshotStore({
      endpoint: s3.endpoint,
      bucket: "b1",
      accessKeyId: "AK",
      secretAccessKey: "SECRET",
      partSize: 5 * 1024 * 1024,
    });
    const f = path.join(dir("mp"), "big.bin");
    fs.writeFileSync(f, crypto.randomBytes(11 * 1024 * 1024));
    await store.put("big", f);
    assert.deepEqual(
      s3.log.map((l) => l.replace(/uploadId=\w+/, "uploadId=U")),
      [
        "POST /b1/big?uploads",
        "PUT /b1/big?partNumber=1&uploadId=U",
        "PUT /b1/big?partNumber=2&uploadId=U",
        "PUT /b1/big?partNumber=3&uploadId=U",
        "POST /b1/big?uploadId=U",
      ],
    );
    assert.ok(s3.objects.get("/b1/big")!.equals(fs.readFileSync(f)));
    s3.server.close();
  });

  test("wrong credentials fail without retries; plain HTTP only for loopback", async () => {
    const s3 = await fakeS3();
    const store = new S3SnapshotStore({
      endpoint: s3.endpoint,
      bucket: "b1",
      accessKeyId: "AK",
      secretAccessKey: "WRONG",
    });
    const f = path.join(dir("wc"), "a");
    fs.writeFileSync(f, "x");
    await assert.rejects(store.put("k", f), /refused PUT: HTTP 403/);
    assert.equal(s3.log.length, 1);
    s3.server.close();
    assert.throws(
      () =>
        new S3SnapshotStore({
          endpoint: "http://example.com",
          bucket: "b1",
          accessKeyId: "a",
          secretAccessKey: "b",
        }),
      /HTTPS/,
    );
  });

  test("service over S3: save and restore a workspace", async () => {
    const s3 = await fakeS3();
    const svc = new SnapshotService(
      new S3SnapshotStore({
        endpoint: s3.endpoint,
        bucket: "b1",
        accessKeyId: "AK",
        secretAccessKey: "SECRET",
      }),
      dir("work"),
    );
    const src = dir("src");
    populate(src);
    const m = await svc.save("u/1/code-1/s1", src);
    const dest = dir("dest");
    await svc.load("u/1/code-1/s1", dest, { sha256: m.sha256 });
    assert.equal(
      fs.readFileSync(path.join(dest, "workspace", "README.md"), "utf8"),
      "# hello\n",
    );
    s3.server.close();
  });
});

// ---------------------------------------------------------------------------
// Real gVisor (Linux, root, sandbox image)

const realRootfs = process.env.CLAUDEX_TEST_RUNSC_ROOTFS;
const realEngine = (process.env.CLAUDEX_TEST_RUNSC_ENGINE ?? "runsc") as
  "runsc" | "containerd";
const skipReal = !realRootfs
  ? "CLAUDEX_TEST_RUNSC_ROOTFS not set"
  : process.platform !== "linux" || process.getuid?.() !== 0
    ? "needs Linux and root"
    : false;

describe(`real gVisor (${realEngine})`, { skip: skipReal }, () => {
  const driverOpts = () => ({
    rootfs: realRootfs!,
    engine: realEngine,
    runtimeConfig: process.env.CLAUDEX_TEST_RUNSC_CONFIG,
    ignoreCgroups: process.env.CLAUDEX_TEST_RUNSC_NO_CGROUPS === "1",
    node: process.execPath,
  });

  test("check passes with a smoke sandbox", async () => {
    const r = await new RunscDriver(driverOpts()).check({ smoke: true });
    assert.equal(r.ok, true, r.problems.join("; "));
  });

  test("isolation: identity, file system, network, bridges, limits", async () => {
    const { dataDir, spec } = codeLayout({ id: "iso-1" });
    const hostSecret = path.join(dir("secret"), "runner.env");
    fs.writeFileSync(hostSecret, "RUNNER_TOKEN=x\n", { mode: 0o600 });
    const gateway = http.createServer((req, res) =>
      res.end(`gateway:${req.url}:${req.headers.authorization ?? ""}`),
    );
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
    const gport = (gateway.address() as net.AddressInfo).port;
    const egressSock = path.join(dir("eg"), "e.sock");
    const egress = net.createServer((c) =>
      c.on("data", () => c.end("HTTP/1.0 200 OK\r\n\r\negress")),
    );
    await new Promise<void>((r) => egress.listen(egressSock, () => r()));
    const probe = `
const fs = require("fs"), net = require("net"), http = require("http"), os = require("os");
const port = Number(process.argv.find((a) => a.startsWith("--port=")).slice(7));
const res = {};
const tryDo = (k, f) => { try { res[k] = f(); } catch (e) { res[k] = "ERR:" + e.code; } };
tryDo("uid", () => process.getuid());
tryDo("hostname", () => os.hostname());
tryDo("kernel", () => fs.readFileSync("/proc/version", "utf8").slice(0, 40));
tryDo("secret", () => fs.readFileSync(${JSON.stringify(hostSecret)}, "utf8"));
tryDo("hostRoot", () => fs.readdirSync(${JSON.stringify(path.dirname(dataDir))}));
tryDo("passwd", () => fs.readFileSync("/etc/passwd", "utf8").split("\\n").filter(Boolean).map((l) => l.split(":")[0]));
tryDo("writeUsr", () => fs.writeFileSync("/usr/x", "x"));
tryDo("writeCodex", () => fs.writeFileSync("/opt/claudex/codex/bin/codex", "x"));
tryDo("writeWorkspace", () => { fs.writeFileSync("/workspace/out.txt", "made in sandbox"); return "ok"; });
tryDo("cwd", () => process.cwd());
tryDo("codexHome", () => process.env.CODEX_HOME);
res.env = Object.keys(process.env).sort();
const get = (p) => new Promise((r) => http.get("http://127.0.0.1:" + p + "/v1/models", { headers: { authorization: "Bearer " + process.env.CLAUDEX_GATEWAY_TOKEN } }, (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => r(d)); }).on("error", (e) => r("ERR:" + e.code)));
const connect = (host, p) => new Promise((r) => { const c = net.connect(p, host, () => { c.destroy(); r("connected"); }); c.on("error", (e) => r("ERR:" + e.code)); setTimeout(() => { c.destroy(); r("timeout"); }, 3000); });
(async () => {
  res.gateway = await get(port);
  res.proxy = await new Promise((r) => { const c = net.connect(3128, "127.0.0.1", () => c.write("GET http://example.com/ HTTP/1.0\\r\\n\\r\\n")); let d = ""; c.on("data", (x) => (d += x)); c.on("end", () => r(d.split("\\r\\n\\r\\n")[1])); c.on("error", (e) => r("ERR:" + e.code)); });
  res.internet = await connect("1.1.1.1", 443);
  res.dns = await new Promise((r) => require("dns").lookup("example.com", (e, a) => r(e ? "ERR:" + e.code : a)));
  process.stdout.write(JSON.stringify(res));
})();
`;
    const image = readImageManifest(realRootfs!);
    const prepared = new RunscDriver(driverOpts()).prepare({
      ...spec,
      egress: { socket: egressSock },
      limits: { ...SANDBOX_CLASSES.chat, memoryMb: 512 },
    });
    const r = await launch(
      prepared.spec,
      ["-e", probe, "--", "-c", GATEWAY_ARG(gport), `--port=${gport}`],
      engineEnv(path.join(dataDir, "codex-home")),
      { command: [image.node], stdio: "pipe", launch: 1 },
    );
    gateway.close();
    egress.close();
    assert.equal(r.code, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    assert.equal(res.uid, 1000);
    assert.equal(res.hostname, "sandbox");
    assert.equal(res.secret, "ERR:ENOENT");
    assert.equal(res.hostRoot, "ERR:ENOENT");
    assert.deepEqual(res.passwd, ["root", "sandbox", "nobody"]);
    assert.match(res.writeUsr, /^ERR:(EROFS|EACCES)$/);
    assert.match(res.writeCodex, /^ERR:(EROFS|EACCES)$/);
    assert.equal(res.writeWorkspace, "ok");
    assert.equal(res.cwd, "/workspace");
    assert.equal(res.codexHome, "/codex-home");
    const out = path.join(dataDir, "workspace", "out.txt");
    assert.equal(fs.readFileSync(out, "utf8"), "made in sandbox");
    assert.equal(fs.statSync(out).uid, 1000);
    assert.equal(res.gateway, "gateway:/v1/models:Bearer loopback-capability");
    assert.equal(res.proxy, "egress");
    assert.match(res.internet, /^ERR:|timeout/);
    assert.match(res.dns, /^ERR:/);
    for (const k of [
      "OPENAI_API_KEY",
      "CLAUDEX_RUNNER_TOKEN",
      "R2_SECRET_ACCESS_KEY",
      "CLAUDEX_SANDBOX_BRIDGE",
    ])
      assert.ok(!res.env.includes(k), k);
    assert.deepEqual(
      new RunscDriver(driverOpts()).list().filter((i) => i === "claudex-iso-1"),
      [],
    );
    prepared.dispose();
  });

  test(
    "the memory limit stops a sandbox that allocates past it",
    { skip: driverOpts().ignoreCgroups && "cgroups ignored" },
    async () => {
      const { dataDir, spec } = codeLayout({ id: "mem-1" });
      const image = readImageManifest(realRootfs!);
      const prepared = new RunscDriver(driverOpts()).prepare({
        ...spec,
        limits: { ...SANDBOX_CLASSES.chat, memoryMb: 256 },
      });
      const r = await launch(
        prepared.spec,
        [
          "-e",
          "const a=[];for(let i=0;i<24;i++){a.push(Buffer.alloc(64*1024*1024,1))};console.log('allocated')",
        ],
        { CODEX_HOME: path.join(dataDir, "codex-home") },
        { command: [image.node], stdio: "pipe", launch: 3 },
      );
      // gVisor's sentry holds the guest memory, so the whole sandbox is
      // killed when it goes past the cgroup limit.
      assert.ok(!r.stdout.includes("allocated"), r.stdout);
      assert.notEqual(r.code, 0);
      prepared.dispose();
    },
  );

  test("real codex app-server answers initialize; exec into the running sandbox; snapshot and restore", async () => {
    const { dataDir, spec } = codeLayout({ id: "codex-1" });
    const driver = new RunscDriver(driverOpts());
    const prepared = driver.prepare(spec);
    const gateway = http.createServer((_q, s) => s.end("{}"));
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
    const gport = (gateway.address() as net.AddressInfo).port;
    const child = spawn(
      prepared.binary,
      [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        'model_provider="claudex"',
        "-c",
        GATEWAY_ARG(gport),
      ],
      { env: engineEnv(path.join(dataDir, "codex-home")), stdio: "pipe" },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const reply = await new Promise<any>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`no reply; stderr: ${stderr.slice(-800)}`));
      }, 120000);
      child.stdout.on("data", (d) => {
        buf += d;
        for (const line of buf.split("\n")) {
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1) {
              clearTimeout(timer);
              resolve(msg);
            }
          } catch {}
        }
      });
      child.stdin.write(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "claudex_test", title: "t", version: "0" },
            capabilities: { experimentalApi: true },
          },
        }) + "\n",
      );
    });
    assert.ok(reply.result, JSON.stringify(reply));
    // exec while codex runs: the diff view path of W-CODEENG.
    fs.writeFileSync(path.join(dataDir, "workspace", "hello.txt"), "hi");
    const ex = await driver.exec(prepared.spec, [
      "sh",
      "-c",
      "id -u; cat hello.txt; echo; git --version",
    ]);
    assert.equal(ex.code, 0, ex.stderr);
    assert.match(ex.stdout, /^1000\nhi\ngit version/);
    const usage = driver.usage(prepared.spec);
    if (!driverOpts().ignoreCgroups)
      assert.ok((usage?.memoryBytes ?? 0) > 0, JSON.stringify(usage));
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    gateway.close();
    assert.ok(fs.readdirSync(path.join(dataDir, "codex-home")).length > 0);
    // Snapshot the stopped sandbox and restore it elsewhere.
    const store = new LocalSnapshotStore(dir("snaps"));
    const svc = new SnapshotService(store, dir("work"));
    const m = await svc.save("code-1/s1", dataDir);
    const other = path.join(dir("other"), "sbx");
    await svc.load("code-1/s1", other, { sha256: m.sha256 });
    assert.equal(
      fs.readFileSync(path.join(other, "workspace", "hello.txt"), "utf8"),
      "hi",
    );
    prepared.dispose();
  });

  test(
    "loop disk quota stops writes at the limit",
    {
      skip:
        process.env.CLAUDEX_TEST_LOOP !== "1" && "CLAUDEX_TEST_LOOP not set",
    },
    async () => {
      const q = new LoopQuota({
        imagesDir: dir("loopimg"),
        owner: { uid: 1000, gid: 1000 },
      });
      const dataDir = path.join(dir("loopdata"), "sbx");
      q.prepare(dataDir, 64);
      try {
        const { spec } = codeLayout({ id: "quota-1", dataDir });
        const image = readImageManifest(realRootfs!);
        const prepared = new RunscDriver(driverOpts()).prepare(spec);
        const r = await launch(
          prepared.spec,
          [
            "-c",
            "dd if=/dev/zero of=/workspace/fill bs=1M count=100 2>&1; echo rc=$?",
          ],
          { CODEX_HOME: path.join(dataDir, "codex-home") },
          { command: ["/bin/sh"], stdio: "pipe", launch: 2 },
        );
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /No space left|rc=1/);
        const st = q.status(dataDir, 64);
        assert.ok(st.usedBytes <= 64 * 1024 * 1024);
        assert.ok(image);
        prepared.dispose();
      } finally {
        q.release(dataDir, { destroy: true });
      }
    },
  );
});
