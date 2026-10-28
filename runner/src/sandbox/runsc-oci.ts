import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_EGRESS_PORT,
  SANDBOX_RUN_DIR,
  sandboxPathOf,
  SandboxSpecError,
} from "./driver.ts";
import {
  BRIDGE_SOURCE,
  sandboxEnv,
  sandboxArgs,
  toSandboxPath,
} from "./sandbox-setup.ts";
import type { SandboxSpec } from "./driver.ts";
import { ociResources } from "./quota.ts";

// ---------------------------------------------------------------------------
// Image manifest

/** Where the image build writes its manifest inside the root file system. */
export const IMAGE_MANIFEST_PATH = "opt/claudex/image.json";

export interface SandboxImage {
  format: "claudex-sandbox-image/1";
  /** Image version, e.g. `2026.09.26-1`. */
  version: string;
  /** `x86_64` or `aarch64`. */
  arch: string;
  codexVersion: string;
  /** In-image path of the codex executable. */
  codex: string;
  /** Hex SHA-256 of that executable (checked by `check()`). */
  codexSha256: string;
  /** In-image Node, used for the in-sandbox bridge. */
  node: string;
  /** Extra PATH entries (codex's bundled rg). */
  pathDirs: string[];
  /**
   * Variables the image's tools need (e.g. where Playwright's browsers
   * are); added under the sandbox's own environment, which wins.
   */
  env?: Record<string, string>;
}

export function cleanAbs(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.startsWith("/") &&
    path.posix.normalize(p) === p &&
    !p.includes("\0") &&
    p !== "/"
  );
}

/** Reads and validates `<rootfs>/opt/claudex/image.json`. */
export function readImageManifest(rootfs: string): SandboxImage {
  const file = path.join(rootfs, IMAGE_MANIFEST_PATH);
  let m: SandboxImage;
  try {
    m = JSON.parse(fs.readFileSync(file, "utf8")) as SandboxImage;
  } catch {
    throw new SandboxSpecError(
      `The sandbox image has no readable manifest (${file}).`,
    );
  }
  if (m.format !== "claudex-sandbox-image/1")
    throw new SandboxSpecError("Unknown sandbox image format.");
  if (!cleanAbs(m.codex) || !cleanAbs(m.node))
    throw new SandboxSpecError("The image manifest has bad codex/node paths.");
  if (!Array.isArray(m.pathDirs) || !m.pathDirs.every(cleanAbs))
    throw new SandboxSpecError("The image manifest has bad PATH entries.");
  if (!/^[0-9a-f]{64}$/.test(m.codexSha256 ?? ""))
    throw new SandboxSpecError("The image manifest has no codex checksum.");
  if (typeof m.version !== "string" || typeof m.codexVersion !== "string")
    throw new SandboxSpecError("The image manifest has no version.");
  if (
    m.env !== undefined &&
    (typeof m.env !== "object" ||
      m.env === null ||
      Array.isArray(m.env) ||
      !Object.entries(m.env).every(
        ([key, value]) =>
          /^[A-Z][A-Z0-9_]{0,63}$/.test(key) &&
          typeof value === "string" &&
          value.length <= 1024 &&
          !value.includes("\0"),
      ))
  )
    throw new SandboxSpecError(
      "The image manifest has bad environment entries.",
    );
  return m;
}

/** Path of an in-image file on the host. */
export function inRootfs(rootfs: string, p: string) {
  return path.join(rootfs, p.replace(/^\/+/, ""));
}

/**
 * Codex's sandbox mode for a permission mode under gVisor (W-SPIKE):
 * workspace-write must keep network access on (its network sandbox cannot
 * start inside gVisor; the outer sandbox has no network but the proxy
 * anyway); Bypass stays the user's choice (decision 3).
 */
export function codexSandboxModeFor(mode: "ask" | "auto" | "bypass" | string) {
  return mode === "bypass"
    ? { sandbox: "danger-full-access" as const }
    : {
        sandbox: "workspace-write" as const,
        sandboxWorkspaceWrite: { networkAccess: true },
      };
}

// ---------------------------------------------------------------------------
// OCI spec

/** Default containerd namespace for sandboxes (kept apart from other users of containerd). */
export const CONTAINERD_NAMESPACE = "claudex";

export const RUNSC_RUNTIME = "io.containerd.runsc.v1";

/** Prefix of every container id this driver creates. */
export const CONTAINER_PREFIX = "claudex-";

/** uid/gid of the sandbox user when the runner itself runs as root. */
export const DEFAULT_SANDBOX_UID = 1000;

export function containerId(spec: Pick<SandboxSpec, "id">) {
  return CONTAINER_PREFIX + spec.id;
}

/** Per-launch host layout below stateDir. */
export function launchPaths(stateDir: string, launch: number) {
  const dir = path.join(stateDir, "run", String(launch));
  return {
    dir,
    fwd: path.join(dir, "fwd"),
    bundle: path.join(dir, "bundle"),
    etc: path.join(dir, "etc"),
    socket: (port: number) => path.join(dir, "fwd", `p${port}.sock`),
    egress: path.join(dir, "fwd", "egress.sock"),
  };
}

/** Linux sun_path limit (107 usable bytes); pid_max is at most 4194304. */
export function runscSocketPathFits(stateDir: string) {
  return launchPaths(stateDir, 4194304).socket(65535).length <= 107;
}

const MASKED_PATHS = [
  "/proc/acpi",
  "/proc/asound",
  "/proc/kcore",
  "/proc/keys",
  "/proc/latency_stats",
  "/proc/timer_list",
  "/proc/timer_stats",
  "/proc/sched_debug",
  "/proc/scsi",
  "/sys/firmware",
];

const READONLY_PATHS = [
  "/proc/bus",
  "/proc/fs",
  "/proc/irq",
  "/proc/sys",
  "/proc/sysrq-trigger",
];

export interface RunscLaunch {
  spec: SandboxSpec;
  /** Engine's codex arguments. */
  args: string[];
  engineEnv: NodeJS.ProcessEnv;
  rootfs: string;
  image: SandboxImage;
  launch: number;
  ports: number[];
  uid: number;
  gid: number;
  /** cgroup v2 path, e.g. `/claudex/code-1`; undefined when cgroups are not managed. */
  cgroupsPath?: string;
  /** Runs this instead of the image's codex (smoke test, diagnostics). */
  command?: string[];
  /** Only the host lease owner may start Codex's curated sync. */
  cacheReader?: boolean;
}

interface OciMount {
  destination: string;
  type: string;
  source: string;
  options?: string[];
}

/** Clears O_NONBLOCK on fds 0-2, then execs its arguments (launch, "relay"). */
export const blockingPython = "/usr/bin/python3";
export const blockingStdio =
  "import os,sys\nfor f in (0,1,2):\n  try: os.set_blocking(f, True)\n  except OSError: pass\nos.execvp(sys.argv[1], sys.argv[1:])";

/**
 * Inside the sandbox: runs its arguments with stdout on a pipe and copies
 * that pipe to fd 1 with blocking writes, passing signals on and exiting
 * with the program's status (see codexArgv in the OCI config).
 */
export const stdoutRelay = [
  "import os, sys, signal, select",
  "r, w = os.pipe()",
  "pid = os.fork()",
  "if pid == 0:",
  "    os.close(r)",
  "    os.dup2(w, 1)",
  "    os.close(w)",
  "    os.execvp(sys.argv[1], sys.argv[1:])",
  "os.close(w)",
  "for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):",
  "    signal.signal(s, lambda n, f: os.kill(pid, n))",
  "try:",
  "    os.set_blocking(1, True)",
  "except OSError:",
  "    pass",
  "def out(data):",
  "    view = memoryview(data)",
  "    while view:",
  "        try:",
  "            view = view[os.write(1, view):]",
  "        except BlockingIOError:",
  "            select.select([], [1], [], 1)",
  "        except InterruptedError:",
  "            pass",
  "while True:",
  "    try:",
  "        data = os.read(r, 65536)",
  "    except InterruptedError:",
  "        continue",
  "    if not data:",
  "        break",
  "    try:",
  "        out(data)",
  "    except BrokenPipeError:",
  "        break",
  "while True:",
  "    try:",
  "        status = os.waitpid(pid, 0)[1]",
  "        break",
  "    except InterruptedError:",
  "        continue",
  "code = os.waitstatus_to_exitcode(status)",
  "sys.exit(128 - code if code < 0 else code)",
].join("\n");

/**
 * The OCI runtime spec for one launch, plus the environment codex sees and
 * the bridge forwards (for tests and logs). The environment carries the
 * loopback gateway token, so the spec file is written 0600 in the
 * runner-private state directory and never appears on a command line.
 */
export function buildOciSpec(launch: RunscLaunch) {
  const { spec, engineEnv, image } = launch;
  const args = sandboxArgs(spec.mounts, launch.args);
  const lp = launchPaths(spec.stateDir, launch.launch);
  const egressPort = spec.egress
    ? (spec.egress.port ?? DEFAULT_EGRESS_PORT)
    : undefined;
  const env = sandboxEnv(
    { ...spec, node: image.node, pathDirs: image.pathDirs },
    engineEnv,
    { proxyPort: egressPort },
  );
  const bind = (source: string, destination: string, writable: boolean) => ({
    destination,
    type: "bind",
    source,
    options: ["rbind", writable ? "rw" : "ro", "nosuid", "nodev"],
  });
  const tmpMb = Math.floor(spec.limits?.tmpMb ?? 256);
  const mounts: OciMount[] = [
    { destination: "/proc", type: "proc", source: "proc" },
    {
      destination: "/dev",
      type: "tmpfs",
      source: "tmpfs",
      options: ["nosuid", "strictatime", "mode=755", "size=65536k"],
    },
    {
      destination: "/dev/shm",
      type: "tmpfs",
      source: "shm",
      options: ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"],
    },
    {
      destination: "/sys",
      type: "sysfs",
      source: "sysfs",
      options: ["nosuid", "noexec", "nodev", "ro"],
    },
    {
      destination: "/tmp",
      type: "tmpfs",
      source: "tmpfs",
      options: ["nosuid", "nodev", "mode=1777", `size=${tmpMb}m`],
    },
    bind(path.join(lp.etc, "passwd"), "/etc/passwd", false),
    bind(path.join(lp.etc, "group"), "/etc/group", false),
  ];
  // User data; shorter targets first so nested mounts land on top.
  for (const m of [...spec.mounts].sort(
    (a, b) => sandboxPathOf(a).length - sandboxPathOf(b).length,
  ))
    mounts.push(bind(m.host, sandboxPathOf(m), m.writable));
  if (launch.cacheReader && spec.codexCache) {
    const lock = path.join(spec.codexCache, "plugins.sync.lock");
    mounts.push(bind(lock, lock, false));
  }
  const forwards: Array<{ port: number; socket: string }> = [];
  for (const port of launch.ports)
    forwards.push({ port, socket: `${SANDBOX_RUN_DIR}/fwd/p${port}.sock` });
  if (egressPort)
    forwards.push({
      port: egressPort,
      socket: `${SANDBOX_RUN_DIR}/fwd/egress.sock`,
    });
  // Bridge sockets last so nothing can shadow them; read-only suffices for connect().
  if (forwards.length)
    mounts.push(bind(lp.fwd, `${SANDBOX_RUN_DIR}/fwd`, false));
  // Codex makes its stdout non-blocking and waits for it to be writable; on the
  // host socket gVisor imports as fd 1 that wait does not hold, so a reply
  // bigger than the socket buffer failed with EAGAIN and codex closed its
  // output. Inside the sandbox the image's python3 gives codex a pipe of
  // gVisor's own as stdout and copies it to fd 1 with blocking writes
  // (reproduced and verified end to end with the real launcher, codex and
  // thread).
  const programArgv = [...(launch.command ?? [image.codex]), ...args];
  const codexArgv = fs.existsSync(inRootfs(launch.rootfs, blockingPython))
    ? [blockingPython, "-c", stdoutRelay, ...programArgv]
    : programArgv;
  const command = forwards.length
    ? [image.node, "-e", BRIDGE_SOURCE]
    : codexArgv;
  const processEnv: Record<string, string> = { ...image.env, ...env };
  if (forwards.length)
    processEnv.CLAUDEX_SANDBOX_BRIDGE = JSON.stringify({
      forwards,
      argv: codexArgv,
    });
  const cwd =
    spec.cwd !== undefined
      ? (toSandboxPath(spec.mounts, spec.cwd) ?? spec.cwd)
      : sandboxPathOf(spec.mounts.find((m) => m.writable)!);
  const noCaps: string[] = [];
  const config = {
    ociVersion: "1.0.2",
    process: {
      terminal: false,
      user: {
        uid: launch.uid,
        gid: launch.gid,
        additionalGids: [] as number[],
      },
      args: command,
      env: Object.entries(processEnv).map(([k, v]) => `${k}=${v}`),
      cwd,
      noNewPrivileges: true,
      capabilities: {
        bounding: noCaps,
        effective: noCaps,
        inheritable: noCaps,
        permitted: noCaps,
        ambient: noCaps,
      },
      rlimits: [{ type: "RLIMIT_NOFILE", hard: 65536, soft: 65536 }],
    },
    root: { path: launch.rootfs, readonly: true },
    hostname: "sandbox",
    mounts,
    linux: {
      namespaces: ["pid", "ipc", "uts", "mount", "network"].map((type) => ({
        type,
      })),
      resources: ociResources(spec.limits),
      ...(launch.cgroupsPath ? { cgroupsPath: launch.cgroupsPath } : {}),
      maskedPaths: MASKED_PATHS,
      readonlyPaths: READONLY_PATHS,
    },
  };
  return { config, env, command, forwards, paths: lp };
}

/** passwd/group for the sandbox user (the image's own files are hidden). */
export function writeRunscIdentity(
  etcDir: string,
  uid: number,
  gid: number,
  home: string,
) {
  fs.mkdirSync(etcDir, { recursive: true, mode: 0o755 });
  const lines =
    uid === 0
      ? `root:x:0:0:root:${home}:/bin/sh\n`
      : `root:x:0:0:root:/root:/usr/sbin/nologin\nsandbox:x:${uid}:${gid}:Claudex sandbox:${home}:/bin/bash\n`;
  fs.writeFileSync(
    path.join(etcDir, "passwd"),
    `${lines}nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n`,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(etcDir, "group"),
    `root:x:0:\n${gid === 0 ? "" : `sandbox:x:${gid}:\n`}nogroup:x:65534:\n`,
    { mode: 0o644 },
  );
}
