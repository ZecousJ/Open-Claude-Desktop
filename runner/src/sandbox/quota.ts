// Resource quotas for runner sandboxes.
//
// - cgroup limits: the runsc driver puts `ociResources(limits)` into each
//   sandbox's OCI spec, so containerd's runsc shim (or runsc itself) creates a
//   cgroup per sandbox with memory (no swap), pids and CPU limits. The runner
//   reads usage back with `readCgroupUsage` for metering and the console.
// - disk limits: a sandbox's data directory (workspace + codex-home) is a
//   quota volume. `loop` gives every sandbox its own ext4 image mounted on
//   the data directory (works on any host file system, e.g. the ext4 VHDX of
//   the WSL2 runner host); `xfs-project` uses XFS project quotas when the
//   data root is on XFS mounted with prjquota; `soft` only measures and
//   reports, for hosts where the runner has no root (the runner then stops a
//   sandbox that goes over its limit).
// - host capacity: `hostCapacity` and `canAdmit` implement the "refuse new
//   sandboxes below 10% free memory" rule of the scheduler.
//
// Erasable TypeScript only (the launcher runs under Node's type stripping).

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SandboxLimits } from "./driver.ts";

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

// ---------------------------------------------------------------------------
// cgroup limits

/** CFS period used for CPU limits (100 ms, the kernel default). */
export const CPU_PERIOD_US = 100_000;

/** The `linux.resources` section of an OCI spec for these limits. */
export function ociResources(limits: SandboxLimits | undefined) {
  const resources: {
    memory?: { limit: number; swap: number };
    pids?: { limit: number };
    cpu?: { quota: number; period: number };
  } = {};
  if (!limits) return resources;
  if (limits.memoryMb) {
    const bytes = Math.floor(limits.memoryMb) * 1024 * 1024;
    // swap is memory+swap in OCI: equal to the limit means no swap.
    resources.memory = { limit: bytes, swap: bytes };
  }
  if (limits.pids) resources.pids = { limit: Math.floor(limits.pids) };
  if (limits.cpus)
    resources.cpu = {
      quota: Math.max(1000, Math.round(limits.cpus * CPU_PERIOD_US)),
      period: CPU_PERIOD_US,
    };
  return resources;
}

export interface CgroupUsage {
  /** Current memory use in bytes (memory.current). */
  memoryBytes?: number;
  /** Highest memory use in bytes (memory.peak, kernel 5.19+). */
  memoryPeakBytes?: number;
  /** Times the memory limit was hit (memory.events "max"). */
  memoryMaxEvents?: number;
  /** Times the OOM killer ran (memory.events "oom_kill"). */
  oomKills?: number;
  pids?: number;
  /** CPU time used in microseconds (cpu.stat usage_usec). */
  cpuUsec?: number;
}

/** Host directory of a cgroup v2 path such as `/claudex/code-1`. */
export function cgroupDir(cgroupsPath: string, root = "/sys/fs/cgroup") {
  const clean = path.posix.normalize("/" + cgroupsPath);
  if (clean.split("/").includes("..")) throw new QuotaError("Bad cgroup path.");
  return path.join(root, clean);
}

/** Reads cgroup v2 usage files; missing files leave fields undefined. */
export function readCgroupUsage(dir: string): CgroupUsage {
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const num = (v: string | undefined) => {
    if (v === undefined) return undefined;
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  };
  const keyed = (v: string | undefined, key: string) => {
    if (!v) return undefined;
    const line = v.split("\n").find((l) => l.startsWith(key + " "));
    return line ? num(line.slice(key.length + 1)) : undefined;
  };
  const events = read("memory.events");
  return {
    memoryBytes: num(read("memory.current")),
    memoryPeakBytes: num(read("memory.peak")),
    memoryMaxEvents: keyed(events, "max"),
    oomKills: keyed(events, "oom_kill"),
    pids: num(read("pids.current")),
    cpuUsec: keyed(read("cpu.stat"), "usage_usec"),
  };
}

/** Controllers the runsc driver needs from cgroup v2. */
export const REQUIRED_CONTROLLERS = ["memory", "pids", "cpu"];

/** Problems with the host's cgroup setup (empty when limits can be enforced). */
export function checkCgroups(root = "/sys/fs/cgroup"): string[] {
  let controllers: string;
  try {
    controllers = fs.readFileSync(
      path.join(root, "cgroup.controllers"),
      "utf8",
    );
  } catch {
    return [
      "cgroup v2 is not mounted at /sys/fs/cgroup; sandbox memory, pids and CPU limits cannot be enforced.",
    ];
  }
  const have = new Set(controllers.trim().split(/\s+/));
  const missing = REQUIRED_CONTROLLERS.filter((c) => !have.has(c));
  return missing.length
    ? [`cgroup v2 lacks the ${missing.join(", ")} controller(s).`]
    : [];
}

// ---------------------------------------------------------------------------
// Host capacity

export interface HostCapacity {
  memTotalBytes: number;
  /** MemAvailable from /proc/meminfo (os.freemem elsewhere). */
  memAvailableBytes: number;
  diskTotalBytes?: number;
  diskFreeBytes?: number;
  cpus: number;
}

export function hostCapacity(dataRoot?: string): HostCapacity {
  let available = os.freemem();
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
    if (m) available = Number(m[1]) * 1024;
  } catch {}
  const cap: HostCapacity = {
    memTotalBytes: os.totalmem(),
    memAvailableBytes: available,
    cpus: os.availableParallelism?.() ?? os.cpus().length,
  };
  if (dataRoot) {
    try {
      const st = fs.statfsSync(dataRoot);
      cap.diskTotalBytes = st.blocks * st.bsize;
      cap.diskFreeBytes = st.bavail * st.bsize;
    } catch {}
  }
  return cap;
}

/**
 * Whether a new sandbox with these limits fits: after reserving its memory
 * limit, at least `reserve` (default 10%) of the host's memory must stay
 * available, and its disk quota must fit in the free space of the data root.
 */
export function canAdmit(
  limits: SandboxLimits,
  cap: HostCapacity,
  reserve = 0.1,
): { ok: boolean; reason?: string } {
  const mem = (limits.memoryMb ?? 0) * 1024 * 1024;
  if (cap.memAvailableBytes - mem < cap.memTotalBytes * reserve)
    return { ok: false, reason: "Not enough free memory on the runner." };
  const disk = (limits.diskMb ?? 0) * 1024 * 1024;
  if (cap.diskFreeBytes !== undefined && disk > cap.diskFreeBytes)
    return { ok: false, reason: "Not enough free disk space on the runner." };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Disk usage

export interface DiskUsage {
  /** Bytes allocated (st_blocks), not apparent sizes: sparse files count as stored. */
  bytes: number;
  entries: number;
  /** True when the walk stopped at `maxEntries`. */
  truncated?: boolean;
}

/**
 * Walks a directory without following symlinks and adds up allocated bytes.
 * Used by the soft quota and for reporting; never follows links out of the
 * tree, so a sandbox cannot make it read other files.
 */
export function measureDisk(
  dir: string,
  opts: { maxEntries?: number } = {},
): DiskUsage {
  const max = opts.maxEntries ?? 2_000_000;
  let bytes = 0;
  let entries = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch {
      continue;
    }
    entries++;
    bytes += st.blocks !== undefined ? st.blocks * 512 : st.size;
    if (entries >= max) return { bytes, entries, truncated: true };
    if (!st.isDirectory()) continue;
    let names: string[];
    try {
      names = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) stack.push(path.join(current, name));
  }
  return { bytes, entries };
}

// ---------------------------------------------------------------------------
// Disk quotas

export type DiskQuotaMode = "loop" | "xfs-project" | "soft";

export interface QuotaStatus {
  mode: DiskQuotaMode;
  limitBytes: number;
  usedBytes: number;
  /** True when usage reached the limit (soft: the runner must stop the sandbox). */
  exceeded: boolean;
}

export interface DiskQuota {
  readonly mode: DiskQuotaMode;
  /**
   * Makes `dir` a volume of at most `mb` MiB (creating it when missing).
   * Idempotent: an existing volume is reused, and grown when `mb` is larger.
   */
  prepare(dir: string, mb: number): QuotaStatus;
  status(dir: string, mb: number): QuotaStatus;
  /** Detaches the volume; the data stays unless `destroy` is set. */
  release(dir: string, opts?: { destroy?: boolean }): void;
}

/** Runs privileged helpers (mount, mkfs.ext4, xfs_quota); `sudo -n` when configured. */
export interface CommandRunner {
  run(argv: string[], opts?: { timeoutMs?: number }): string;
}

export function commandRunner(opts: { sudo?: boolean } = {}): CommandRunner {
  return {
    run(argv, o = {}) {
      const full = opts.sudo ? ["sudo", "-n", ...argv] : argv;
      const r = spawnSync(full[0], full.slice(1), {
        encoding: "utf8",
        timeout: o.timeoutMs ?? 120_000,
        env: { PATH: process.env.PATH || "/usr/sbin:/usr/bin:/sbin:/bin" },
      });
      if (r.error || r.status !== 0)
        throw new QuotaError(
          `${path.basename(argv[0])} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 300)}`,
        );
      return r.stdout;
    },
  };
}

function assertDir(dir: string) {
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir || dir === "/")
    throw new QuotaError(
      "Quota directories must be absolute, normalized paths.",
    );
}

function assertMb(mb: number) {
  if (!Number.isInteger(mb) || mb < 16 || mb > 16 * 1024 * 1024)
    throw new QuotaError(
      "Disk quota must be a whole number of MiB (16 or more).",
    );
}

/** Mount entries from /proc/self/mountinfo (mount point and source). */
export function readMounts(
  text?: string,
): Array<{ mountPoint: string; source: string; fsType: string }> {
  let body = text;
  if (body === undefined) {
    try {
      body = fs.readFileSync("/proc/self/mountinfo", "utf8");
    } catch {
      return [];
    }
  }
  const unescape = (s: string) =>
    s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  const out: Array<{ mountPoint: string; source: string; fsType: string }> = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const [left, right] = line.split(" - ");
    if (!right) continue;
    const l = left.split(" ");
    const r = right.split(" ");
    out.push({
      mountPoint: unescape(l[4]),
      fsType: r[0],
      source: unescape(r[1]),
    });
  }
  return out;
}

/** Measures only; the runner enforces the limit by stopping the sandbox. */
export class SoftQuota implements DiskQuota {
  readonly mode = "soft" as const;
  prepare(dir: string, mb: number) {
    assertDir(dir);
    assertMb(mb);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return this.status(dir, mb);
  }
  status(dir: string, mb: number): QuotaStatus {
    const limitBytes = mb * 1024 * 1024;
    const used = measureDisk(dir).bytes;
    return {
      mode: this.mode,
      limitBytes,
      usedBytes: used,
      exceeded: used >= limitBytes,
    };
  }
  release(dir: string, opts: { destroy?: boolean } = {}) {
    if (opts.destroy) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One sparse ext4 image per sandbox, loop-mounted on the data directory
 * (nosuid, nodev). The kernel enforces the size; `statfs` reports usage.
 * Needs root (or `sudo -n` for mount, umount, mkfs.ext4, losetup, resize2fs).
 */
export class LoopQuota implements DiskQuota {
  readonly mode = "loop" as const;
  private imagesDir: string;
  private runner: CommandRunner;
  private owner: { uid: number; gid: number };
  private mounts: typeof readMounts;
  constructor(opts: {
    /** Directory holding the images (outside every sandbox mount). */
    imagesDir: string;
    runner?: CommandRunner;
    /** Owner of the volume's root directory (the sandbox user). */
    owner?: { uid: number; gid: number };
    /** For tests. */
    mounts?: typeof readMounts;
  }) {
    this.imagesDir = opts.imagesDir;
    this.runner = opts.runner ?? commandRunner();
    this.owner = opts.owner ?? {
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    };
    this.mounts = opts.mounts ?? readMounts;
  }

  /** Image file for a data directory (stable name from the path). */
  imageFor(dir: string) {
    const h = crypto
      .createHash("sha256")
      .update(dir)
      .digest("hex")
      .slice(0, 16);
    return path.join(this.imagesDir, `${path.basename(dir)}-${h}.ext4`);
  }

  private mounted(dir: string) {
    return this.mounts().find((m) => m.mountPoint === dir);
  }

  prepare(dir: string, mb: number) {
    assertDir(dir);
    assertMb(mb);
    fs.mkdirSync(this.imagesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const image = this.imageFor(dir);
    const bytes = mb * 1024 * 1024;
    if (!fs.existsSync(image)) {
      if (fs.readdirSync(dir).length)
        throw new QuotaError(
          `${dir} is not empty; restore data after the quota volume is mounted.`,
        );
      const fd = fs.openSync(image, "wx", 0o600);
      try {
        fs.ftruncateSync(fd, bytes);
      } finally {
        fs.closeSync(fd);
      }
      this.runner.run([
        "mkfs.ext4",
        "-q",
        "-F",
        "-m",
        "0",
        "-E",
        `root_owner=${this.owner.uid}:${this.owner.gid}`,
        image,
      ]);
    }
    const mount = this.mounted(dir);
    if (!mount)
      this.runner.run([
        "mount",
        "-t",
        "ext4",
        "-o",
        "loop,nosuid,nodev,noatime",
        image,
        dir,
      ]);
    // Grow in place when the class limit went up (ext4 grows online).
    if (fs.statSync(image).size < bytes) {
      const device = (this.mounted(dir) ?? mount)?.source;
      fs.truncateSync(image, bytes);
      if (device && device.startsWith("/dev/loop")) {
        this.runner.run(["losetup", "-c", device]);
        this.runner.run(["resize2fs", device]);
      }
    }
    // The ext4 root has lost+found; the data layout lives beside it.
    return this.status(dir, mb);
  }

  status(dir: string, mb: number): QuotaStatus {
    const limitBytes = mb * 1024 * 1024;
    let used = 0;
    let exceeded = false;
    if (this.mounted(dir)) {
      const st = fs.statfsSync(dir);
      used = (st.blocks - st.bfree) * st.bsize;
      exceeded = st.bavail === 0;
    } else {
      used = measureDisk(dir).bytes;
      exceeded = used >= limitBytes;
    }
    return { mode: this.mode, limitBytes, usedBytes: used, exceeded };
  }

  release(dir: string, opts: { destroy?: boolean } = {}) {
    assertDir(dir);
    if (this.mounted(dir)) this.runner.run(["umount", dir]);
    if (opts.destroy) {
      fs.rmSync(this.imageFor(dir), { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * XFS project quotas: each data directory gets a project id derived from its
 * path and a hard block limit. The data root must be on XFS mounted with
 * `prjquota`. Needs root (or `sudo -n xfs_quota`).
 */
export class XfsProjectQuota implements DiskQuota {
  readonly mode = "xfs-project" as const;
  private runner: CommandRunner;
  private mounts: typeof readMounts;
  constructor(
    opts: { runner?: CommandRunner; mounts?: typeof readMounts } = {},
  ) {
    this.runner = opts.runner ?? commandRunner();
    this.mounts = opts.mounts ?? readMounts;
  }

  /** Project id in 100000..2^31-1, stable for a path. */
  projectId(dir: string) {
    const h = crypto.createHash("sha256").update(dir).digest();
    return 100_000 + (h.readUInt32BE(0) % (2 ** 31 - 100_001));
  }

  /** The XFS mount holding `dir` (longest mount point prefix). */
  fsRoot(dir: string) {
    const candidates = this.mounts()
      .filter(
        (m) =>
          m.mountPoint === "/" ||
          dir === m.mountPoint ||
          dir.startsWith(m.mountPoint + "/"),
      )
      .sort((a, b) => b.mountPoint.length - a.mountPoint.length);
    const m = candidates[0];
    if (!m || m.fsType !== "xfs")
      throw new QuotaError(`${dir} is not on an XFS file system.`);
    return m.mountPoint;
  }

  prepare(dir: string, mb: number) {
    assertDir(dir);
    assertMb(mb);
    // xfs_quota splits its -c command on whitespace.
    if (/\s/.test(dir))
      throw new QuotaError("XFS quota directories cannot contain spaces.");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const root = this.fsRoot(dir);
    const id = this.projectId(dir);
    this.runner.run([
      "xfs_quota",
      "-x",
      "-c",
      `project -s -p ${dir} ${id}`,
      root,
    ]);
    this.runner.run([
      "xfs_quota",
      "-x",
      "-c",
      `limit -p bhard=${mb}m ${id}`,
      root,
    ]);
    return this.status(dir, mb);
  }

  status(dir: string, mb: number): QuotaStatus {
    // With PROJINHERIT set, statfs on the directory reports the project's
    // limit and usage.
    const limitBytes = mb * 1024 * 1024;
    const st = fs.statfsSync(dir);
    const used = (st.blocks - st.bfree) * st.bsize;
    return {
      mode: this.mode,
      limitBytes,
      usedBytes: used,
      exceeded: st.bavail === 0 || used >= limitBytes,
    };
  }

  release(dir: string, opts: { destroy?: boolean } = {}) {
    assertDir(dir);
    const root = this.fsRoot(dir);
    const id = this.projectId(dir);
    this.runner.run(["xfs_quota", "-x", "-c", `limit -p bhard=0 ${id}`, root]);
    if (opts.destroy) {
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      this.runner.run([
        "xfs_quota",
        "-x",
        "-c",
        `project -C -p ${dir} ${id}`,
        root,
      ]);
    }
  }
}

export function createDiskQuota(
  mode: DiskQuotaMode,
  opts: {
    imagesDir?: string;
    sudo?: boolean;
    owner?: { uid: number; gid: number };
  } = {},
): DiskQuota {
  const runner = commandRunner({ sudo: opts.sudo });
  if (mode === "loop") {
    if (!opts.imagesDir)
      throw new QuotaError("The loop quota needs an images directory.");
    return new LoopQuota({
      imagesDir: opts.imagesDir,
      runner,
      owner: opts.owner,
    });
  }
  if (mode === "xfs-project") return new XfsProjectQuota({ runner });
  return new SoftQuota();
}
