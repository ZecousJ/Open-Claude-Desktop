// gVisor (runsc) sandbox driver (W-GVISOR): the production driver of the web
// runner (W-RUN 4.1). Each sandbox is an OCI container run by gVisor:
//
// - engine "runsc" (default): `runsc run --bundle <dir>` with
//   --network=none and --host-uds=open; runsc creates the per-sandbox cgroup
//   from the spec. Verified end to end (real codex, limits, quota) on Linux.
// - engine "containerd": `ctr run --runtime io.containerd.runsc.v1 --config
//   <spec>`; containerd's runsc shim owns the lifecycle (runsc.toml sets
//   network=none). With containerd 2.3.6 and gVisor 20260921 in the test VM
//   the shim hung after `runsc create`; run `check({ smoke: true })` on the
//   runner host before choosing it.
// Neither needs Docker or changes iptables (the sandbox has no network
// stack, only Unix sockets).
//
// The root file system is the unpacked `claudex-sandbox` image
// (deploy/claudex-runner/image), read-only; the image manifest
// (/opt/claudex/image.json) names the pinned codex and the Node used for the
// in-sandbox bridge. The only host paths the sandbox sees are its data
// mounts (workspace and codex-home, usually a disk-quota volume), a
// per-launch directory with the bridge sockets (model gateway and egress
// proxy; runsc --host-uds=open lets the sandbox connect to them) and two
// synthesized files, /etc/passwd and /etc/group. The process runs as a
// non-root user without capabilities, with no-new-privileges, under the
// memory (no swap), pids and CPU limits of its class.
//
// Like bwrap.ts, this file is also the launcher program: RunscDriver.prepare
// writes `<stateDir>/codex`, which runs `node runsc.ts --spec … -- <codex
// args>` (Node's type stripping, erasable syntax only).
//
// Codex's own sandbox under gVisor (W-SPIKE conclusion 2): `workspace-write`
// with network off breaks every command there; the runner maps permission
// modes to `workspace-write` with `networkAccess: true` or
// `danger-full-access` (see `codexSandboxModeFor`).

import { spawn } from "node:child_process";
import fs from "node:fs";
import { pluginCacheLease } from "./plugin-cache.ts";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  listenUnixToTcp,
  listenUnixToUnix,
  loopbackPorts,
} from "./sandbox-setup.ts";
import type { SandboxSpec } from "./driver.ts";
import { removeHostWriteTraps } from "./bwrap.ts";
import {
  readImageManifest,
  containerId,
  launchPaths,
  buildOciSpec,
  writeRunscIdentity,
} from "./runsc-oci.ts";
import {
  type RunscDriverOptions,
  optionsToSpec,
  specOptions,
  runCommand,
  cleanupCommands,
  launcherEnv,
  quiet,
  chownTree,
  realRootfs,
} from "./runsc-commands.ts";
import { blockingPython, blockingStdio } from "./runsc-oci.ts";

export function specOptionsFor(
  opts: RunscDriverOptions,
  spec: SandboxSpec,
): SandboxSpec {
  const image = readImageManifest(opts.rootfs);
  return {
    ...spec,
    codexBinary: image.codex,
    node: image.node,
    pathDirs: image.pathDirs,
    // The real directory, as prepare() pins it: runsc refuses a root whose
    // path goes through a symbolic link (images/current).
    options: {
      ...optionsToSpec(opts),
      rootfs: realRootfs(opts.rootfs),
      ...spec.options,
    },
  };
}

// ---------------------------------------------------------------------------
// Launch (the launcher program's body)

export interface LaunchOptions {
  /** Runs this instead of the image's codex (smoke test, diagnostics). */
  command?: string[];
  /**
   * "relay" for the launcher (codex JSON-RPC on stdio, through pipes of its
   * own: see launch()), "pipe" to collect output; "inherit" hands this
   * process's stdio down as is.
   */
  stdio?: "inherit" | "pipe" | "relay";
  /** stdin for "pipe" mode. */
  input?: string;
  /** Launch number (default: this process's pid). */
  launch?: number;
}

/**
 * Runs one sandbox launch to completion: bridges, spec, identity files,
 * leftover cleanup, the container itself, signal forwarding, teardown.
 */
export async function launch(
  spec: SandboxSpec,
  args: string[],
  engineEnv: NodeJS.ProcessEnv,
  lo: LaunchOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const o = specOptions(spec);
  const image = readImageManifest(o.rootfs);
  const n = lo.launch ?? process.pid;
  const lp = launchPaths(spec.stateDir, n);
  const id = containerId(spec);
  const servers: net.Server[] = [];
  // A previous launch killed with SIGKILL can leave its container behind.
  // Remove it before touching the mounts as root below (HOME, config.toml
  // traps, chown): a still-running sandbox could race those host-side steps.
  for (const cmd of cleanupCommands(o, id)) quiet(cmd);
  fs.rmSync(lp.dir, { recursive: true, force: true });
  fs.mkdirSync(lp.fwd, { recursive: true, mode: 0o700 });
  fs.mkdirSync(lp.bundle, { recursive: true, mode: 0o700 });
  const cacheLease = spec.codexCache
    ? pluginCacheLease(path.dirname(spec.stateDir), spec.codexCache)
    : undefined;
  try {
    if (spec.codexCache) {
      const descriptor = fs.openSync(
        path.join(spec.codexCache, "plugins.sync.lock"),
        fs.constants.O_CREAT |
          fs.constants.O_APPEND |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      fs.closeSync(descriptor);
    }
    const ports = loopbackPorts(args);
    for (const port of ports)
      servers.push(await listenUnixToTcp(lp.socket(port), port));
    if (spec.egress)
      servers.push(await listenUnixToUnix(lp.egress, spec.egress.socket));
    // gVisor checks connect() against the socket's mode as the sandbox
    // user, which is not the socket's owner when the runner runs as root.
    for (const f of fs.readdirSync(lp.fwd))
      fs.chmodSync(path.join(lp.fwd, f), 0o666);
    const built = buildOciSpec({
      spec,
      args,
      engineEnv,
      rootfs: o.rootfs,
      image,
      command: lo.command ?? o.command,
      launch: n,
      ports,
      cacheReader: cacheLease && !cacheLease.writable,
      uid: o.uid,
      gid: o.gid,
      cgroupsPath: o.ignoreCgroups
        ? undefined
        : path.posix.join(o.cgroupParent, id),
    });
    // HOME lives on a writable mount; create it on the host side.
    const hostHome = engineEnv.CODEX_HOME;
    if (hostHome && built.env.HOME === `${built.env.CODEX_HOME}/home`)
      fs.mkdirSync(path.join(hostHome, "home"), {
        recursive: true,
        mode: 0o700,
      });
    writeRunscIdentity(lp.etc, o.uid, o.gid, built.env.HOME);
    removeHostWriteTraps(hostHome);
    if (process.getuid?.() === 0)
      for (const m of spec.mounts)
        if (m.writable) chownTree(m.host, o.uid, o.gid);
    // The launch directory must be reachable by the sandbox user only
    // through the bind mounts: 0711 lets the gofer traverse, nobody list.
    fs.chmodSync(lp.dir, 0o711);
    fs.chmodSync(lp.fwd, 0o755);
    fs.writeFileSync(
      path.join(lp.bundle, "config.json"),
      JSON.stringify(built.config),
      { mode: 0o600 },
    );
    const command = runCommand(o, lp.bundle, id);
    const pipe = lo.stdio === "pipe";
    // Relayed: the engine's stdio sockets reach this process with O_NONBLOCK
    // set, and handed down as they are, gVisor gives codex a non-blocking
    // stdout, so a reply bigger than the socket buffer (the thread's whole
    // history, ~2 MB) failed with EAGAIN and codex closed its output. Pipes of
    // our own are blocking on codex's side; Node carries the bytes with
    // backpressure.
    const relay = lo.stdio === "relay";
    // Node's own child pipes are non-blocking on the child's side too (seen
    // on r1: the runsc child's fd 1 had O_NONBLOCK): a tiny python3 step
    // makes stdin, stdout and stderr blocking, then becomes runsc.
    const run =
      relay && fs.existsSync(blockingPython)
        ? [blockingPython, "-c", blockingStdio, ...command]
        : command;
    const child = spawn(run[0], run.slice(1), {
      stdio: pipe
        ? ["pipe", "pipe", "pipe"]
        : relay
          ? ["pipe", "pipe", "inherit"]
          : "inherit",
      env: launcherEnv(),
    });
    if (relay) {
      child.stdin!.on("error", () => {});
      process.stdout.on("error", () => {});
      process.stdin.pipe(child.stdin!);
      child.stdout!.pipe(process.stdout);
    }
    let stdout = "";
    let stderr = "";
    if (pipe) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(lo.input ?? "");
      child.stdout!.on("data", (d) => (stdout += d));
      child.stderr!.on("data", (d) => (stderr += d));
    }
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
    const forward = (s: NodeJS.Signals) => {
      try {
        child.kill(s);
      } catch {}
    };
    for (const s of signals) process.on(s, forward);
    const code = await new Promise<number>((resolve) => {
      child.once("error", (error) => {
        stderr += error.message;
        if (!pipe) process.stderr.write(`sandbox-codex: ${error.message}\n`);
        resolve(127);
      });
      child.once("close", (status, signal) =>
        resolve(
          status ?? 128 + ((signal && os.constants.signals[signal]) || 0),
        ),
      );
    });
    for (const s of signals) process.off(s, forward);
    return { code, stdout, stderr };
  } finally {
    for (const s of servers) s.close();
    // --rm removes the container on a normal exit; make sure after a crash.
    if (o.engine === "runsc")
      for (const cmd of cleanupCommands(o, id)) quiet(cmd);
    cacheLease?.release();
    fs.rmSync(lp.dir, { recursive: true, force: true });
    try {
      removeHostWriteTraps(engineEnv.CODEX_HOME);
    } catch {}
  }
}
