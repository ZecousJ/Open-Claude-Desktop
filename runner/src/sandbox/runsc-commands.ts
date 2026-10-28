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

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxSpecError } from "./driver.ts";
import type { SandboxSpec } from "./driver.ts";
import { openVerified } from "./snapshot.ts";
import {
  cleanAbs,
  CONTAINERD_NAMESPACE,
  RUNSC_RUNTIME,
  DEFAULT_SANDBOX_UID,
} from "./runsc-oci.ts";

// ---------------------------------------------------------------------------
// Commands

export interface RunscDriverOptions {
  /** "runsc" (default, runsc run --bundle) or "containerd" (ctr + runsc shim). */
  engine?: "containerd" | "runsc";
  /** Unpacked sandbox image (read-only), e.g. /var/lib/claudex-runner/images/current/rootfs. */
  rootfs: string;
  /** Check codex's SHA-256 against the image manifest in check() (default true). */
  verifyImage?: boolean;
  // containerd engine
  ctr?: string;
  /** containerd socket (default: ctr's default /run/containerd/containerd.sock). */
  containerdAddress?: string;
  namespace?: string;
  runtime?: string;
  /** runsc.toml for the shim (deploy/claudex-runner/image/runsc.toml). */
  runtimeConfig?: string;
  // runsc engine
  runsc?: string;
  runscRoot?: string;
  /** gVisor platform (default systrap; ptrace on hosts without it). */
  platform?: string;
  /** Extra global runsc flags (runsc engine). */
  runscFlags?: string[];
  /** Skip cgroup setup (runsc engine only; limits are then not enforced). */
  ignoreCgroups?: boolean;
  /** Parent cgroup for sandboxes (default /claudex). */
  cgroupParent?: string;
  /** Sandbox user (default: the runner's uid, or 1000 when the runner is root). */
  uid?: number;
  gid?: number;
  /** Launcher program (default: runner/bin/sandbox-runsc). */
  wrapper?: string;
  /**
   * Run runsc through `sudo -n` (a dedicated sudoers rule): the runner stays
   * an unprivileged user, so the sandbox runs as that user and host-side
   * writes into sandbox folders are never root's.
   */
  sudo?: boolean;
  /** Node that runs the launcher. */
  node?: string;
}

/** Options serialized into the spec (strings only, like bwrap's). */
type SpecOptions = Record<string, string | undefined>;

function defaultIds() {
  const uid = process.getuid?.() ?? DEFAULT_SANDBOX_UID;
  const gid = process.getgid?.() ?? DEFAULT_SANDBOX_UID;
  return uid === 0
    ? { uid: DEFAULT_SANDBOX_UID, gid: DEFAULT_SANDBOX_UID }
    : { uid, gid };
}

export function optionsToSpec(o: RunscDriverOptions): SpecOptions {
  const ids = defaultIds();
  return {
    driver: "runsc",
    engine: o.engine ?? "runsc",
    rootfs: o.rootfs,
    ctr: o.ctr,
    containerdAddress: o.containerdAddress,
    namespace: o.namespace,
    runtime: o.runtime,
    runtimeConfig: o.runtimeConfig,
    runsc: o.runsc,
    runscRoot: o.runscRoot,
    platform: o.platform,
    runscFlags: o.runscFlags ? JSON.stringify(o.runscFlags) : undefined,
    ignoreCgroups: o.ignoreCgroups ? "1" : undefined,
    cgroupParent: o.cgroupParent,
    uid: String(o.uid ?? ids.uid),
    gid: String(o.gid ?? o.uid ?? ids.gid),
    sudo: o.sudo ? "1" : undefined,
  };
}

export function specOptions(spec: SandboxSpec) {
  const o = spec.options ?? {};
  let flags: string[] = [];
  if (o.runscFlags) {
    const parsed = JSON.parse(o.runscFlags) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every((f) => typeof f === "string" && f.startsWith("--"))
    )
      throw new SandboxSpecError("runscFlags must be a list of --flags.");
    flags = parsed as string[];
  }
  const engine = o.engine === "containerd" ? "containerd" : "runsc";
  const uid = Number(o.uid ?? defaultIds().uid);
  const gid = Number(o.gid ?? defaultIds().gid);
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0)
    throw new SandboxSpecError("Bad sandbox uid/gid.");
  if (!o.rootfs || !cleanAbs(o.rootfs))
    throw new SandboxSpecError("The runsc driver needs an absolute rootfs.");
  const cgroupParent = o.cgroupParent ?? "/claudex";
  if (!cleanAbs(cgroupParent))
    throw new SandboxSpecError("cgroupParent must be an absolute path.");
  return {
    engine,
    rootfs: o.rootfs,
    ctr: o.ctr || "ctr",
    containerdAddress: o.containerdAddress,
    namespace: o.namespace || CONTAINERD_NAMESPACE,
    runtime: o.runtime || RUNSC_RUNTIME,
    runtimeConfig: o.runtimeConfig,
    runsc: o.runsc || "runsc",
    runscRoot: o.runscRoot || "/run/claudex-runsc",
    platform: o.platform || "systrap",
    runscFlags: flags,
    ignoreCgroups: o.ignoreCgroups === "1" && engine === "runsc",
    cgroupParent,
    uid,
    gid,
    sudo: o.sudo === "1",
    // A program of the image other than codex (git for the Changes panel).
    command: o.command ? programOf(o.command) : undefined,
  };
}

function programOf(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    !parsed.every((p) => typeof p === "string") ||
    !path.posix.isAbsolute(parsed[0] as string)
  )
    throw new SandboxSpecError(
      "command must be an absolute program and its arguments.",
    );
  return parsed as string[];
}

type Resolved = ReturnType<typeof specOptions>;

export function ctrBase(o: Resolved) {
  return [
    o.ctr,
    ...(o.containerdAddress ? ["--address", o.containerdAddress] : []),
    "--namespace",
    o.namespace,
  ];
}

function runscBase(o: Resolved) {
  return [...(o.sudo ? ["sudo", "-n"] : []), o.runsc, "--root", o.runscRoot];
}

/** The command that runs one launch (stdio attached). */
export function runCommand(o: Resolved, bundleDir: string, id: string) {
  if (o.engine === "containerd")
    return [
      ...ctrBase(o),
      "run",
      "--rm",
      "--runtime",
      o.runtime,
      ...(o.runtimeConfig ? ["--runtime-config-path", o.runtimeConfig] : []),
      "--config",
      path.join(bundleDir, "config.json"),
      id,
    ];
  return [
    ...runscBase(o),
    "--platform",
    o.platform,
    "--network=none",
    "--host-uds=open",
    ...(o.ignoreCgroups ? ["--ignore-cgroups"] : []),
    ...o.runscFlags,
    "run",
    "--bundle",
    bundleDir,
    id,
  ];
}

/** Commands that remove a leftover container with this id (errors ignored). */
export function cleanupCommands(o: Resolved, id: string) {
  if (o.engine === "containerd")
    return [
      [...ctrBase(o), "task", "kill", "--signal", "SIGKILL", id],
      [...ctrBase(o), "task", "delete", "--force", id],
      [...ctrBase(o), "container", "delete", id],
    ];
  return [[...runscBase(o), "delete", "--force", id]];
}

/** Runs a command in a running sandbox. */
export function execCommand(
  o: Resolved,
  id: string,
  argv: string[],
  cwd: string,
) {
  if (o.engine === "containerd")
    return [
      ...ctrBase(o),
      "task",
      "exec",
      "--exec-id",
      `x${crypto.randomBytes(6).toString("hex")}`,
      "--user",
      `${o.uid}:${o.gid}`,
      "--cwd",
      cwd,
      id,
      ...argv,
    ];
  return [
    ...runscBase(o),
    "exec",
    "--user",
    `${o.uid}:${o.gid}`,
    "--cwd",
    cwd,
    id,
    ...argv,
  ];
}

export function listCommand(o: Resolved) {
  return o.engine === "containerd"
    ? [...ctrBase(o), "container", "list", "--quiet"]
    : [...runscBase(o), "list", "--quiet"];
}

const SYSTEM_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** The launcher's own environment (PATH only; the sandbox gets its env from the spec). */
export function launcherEnv() {
  return {
    PATH: process.env.PATH ? `${process.env.PATH}:${SYSTEM_PATH}` : SYSTEM_PATH,
  };
}

/**
 * Absolute path of a tool, resolved on the runner's PATH when the driver is
 * prepared: the launcher runs with Engine's environment, whose PATH need not
 * contain runsc or ctr.
 */
export function resolveTool(name: string) {
  if (name.includes("/")) return name;
  for (const dir of launcherEnv().PATH.split(":")) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return name;
}

export function quiet(argv: string[], timeout = 30_000) {
  return spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    env: launcherEnv(),
    timeout,
  });
}

/**
 * Makes the writable mounts owned by the sandbox user. Only needed when the
 * runner runs as root (it wrote config.toml, restored snapshots, …). Never
 * follows symlinks (links keep their owner; it does not matter for them) and
 * changes ownership through a verified descriptor (`openVerified`), so even
 * a sandbox that is still running cannot redirect it to a host file. Stop
 * the sandbox first anyway: `launch` removes a leftover container before it
 * gets here.
 */
export function chownTree(dir: string, uid: number, gid: number) {
  const root = (() => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return dir;
    }
  })();
  const stack = [""];
  let changed = 0;
  while (stack.length) {
    const rel = stack.pop()!;
    const cur = rel ? path.join(dir, rel) : dir;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    const fd = openVerified(cur, rel ? path.join(root, rel) : root);
    if (fd === undefined) continue; // sockets, vanished or swapped entries
    try {
      const fst = fs.fstatSync(fd);
      if (fst.uid !== uid || fst.gid !== gid) {
        fs.fchownSync(fd, uid, gid);
        changed++;
      }
      if (!fst.isDirectory()) continue;
    } finally {
      fs.closeSync(fd);
    }
    let names: string[] = [];
    try {
      names = fs.readdirSync(cur);
    } catch {}
    for (const n of names) stack.push(rel ? path.join(rel, n) : n);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Driver

export function realRootfs(rootfs: string) {
  try {
    return fs.realpathSync(rootfs);
  } catch {
    return rootfs;
  }
}

/** runner/bin/sandbox-runsc next to this source (the bundled runner passes its own). */
export function defaultWrapper() {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../bin/sandbox-runsc",
  );
}
