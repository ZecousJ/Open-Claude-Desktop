import fs from "node:fs";
import path from "node:path";

/** How strongly a driver isolates the sandbox from the host kernel. */
export type IsolationStrength = "namespaces" | "gvisor";

/** Network levels of W-RUN 4.2 (enforced by the egress proxy, W-EGRESS). */
export type NetworkLevel = "none" | "trusted" | "full" | "custom";

/** A host directory made visible inside the sandbox. */
export interface SandboxMount {
  /** Absolute host path; must exist and be a directory. */
  host: string;
  /** Absolute path inside the sandbox; defaults to `host` (identity mount). */
  sandbox?: string;
  /** Writable mounts are the only places the sandbox can write persistently. */
  writable: boolean;
}

/** Resource limits for the sandbox's process tree. */
export interface SandboxLimits {
  /** Memory ceiling in MiB (W-RUN 10.1: 768 MiB in single mode). */
  memoryMb?: number;
  /** Maximum number of tasks (processes and threads). */
  pids?: number;
  /** CPU share in cores (0.5 = half a core). */
  cpus?: number;
  /** Disk space for the sandbox's writable data in MiB (quota.ts; runsc driver). */
  diskMb?: number;
  /** Size of the in-sandbox /tmp tmpfs in MiB (runsc driver; counts against memory). */
  tmpMb?: number;
}

/** Sandbox classes of W-RUN 4.1 (defaults; the control plane may change them). */
export const SANDBOX_CLASSES: Record<
  "chat" | "cowork" | "code",
  Required<SandboxLimits>
> = {
  chat: { cpus: 0.5, memoryMb: 512, diskMb: 2048, pids: 256, tmpMb: 128 },
  cowork: { cpus: 1, memoryMb: 1024, diskMb: 5120, pids: 512, tmpMb: 256 },
  code: { cpus: 2, memoryMb: 2048, diskMb: 10240, pids: 1024, tmpMb: 512 },
};

/**
 * Everything a launcher needs to start codex in one sandbox. The runner builds
 * it (see `chatSandboxSpec`), the driver validates and stores it next to the
 * launcher, outside every mount the sandbox can write.
 */
export interface SandboxSpec {
  /** Stable id, e.g. `chat-<user id>`; used in file names and logs. */
  id: string;
  kind: "chat" | "cowork" | "code";
  /** Runner-private directory for the launcher, the spec and bridge sockets. */
  stateDir: string;
  /** Absolute host path of the real codex executable. */
  codexBinary: string;
  /** Read-only host directory holding the codex package (default: dirname of codexBinary). */
  codexRoot?: string;
  /** Extra directories prepended to PATH inside the sandbox (e.g. codex's bundled rg). */
  pathDirs?: string[];
  /** Node used for the in-sandbox bridge (default: the runner's own Node). */
  node?: string;
  mounts: SandboxMount[];
  /** Shared regenerable marketplace sync parent; gVisor uses one host writer. */
  codexCache?: string;
  /** Working directory inside the sandbox (default: first writable mount). */
  cwd?: string;
  /** HOME inside the sandbox (default: `<CODEX_HOME>/home`). */
  home?: string;
  /**
   * The runner's egress proxy (W-EGRESS) as a host Unix socket. Without it
   * the sandbox has no network at all besides the model gateway bridge.
   */
  egress?: { socket: string; port?: number };
  /** Extra environment for codex (names are checked against the deny list). */
  env?: Record<string, string>;
  limits?: SandboxLimits;
  /** Driver-specific options, e.g. `{ bwrap: "/usr/bin/bwrap" }`. */
  options?: Record<string, string | undefined>;
}

/** The result of preparing a sandbox: the executable handed to Engine. */
export interface PreparedSandbox {
  /** Pass this to `new Engine(store, binary, …)` as the codex binary. */
  binary: string;
  specPath: string;
  spec: SandboxSpec;
  /** Removes the launcher and spec (never the mounted user data). */
  dispose(): void;
}

export interface DriverCheck {
  ok: boolean;
  driver: string;
  version?: string;
  /** Human-readable problems (English; shown in runner logs and the console). */
  problems: string[];
  /** Non-fatal notes, e.g. "resource limits are not enforced". */
  warnings: string[];
}

export interface SandboxDriver {
  readonly name: "bwrap" | "runsc";
  readonly isolation: IsolationStrength;
  /** Verifies the host can run sandboxes with this driver. */
  check(): Promise<DriverCheck>;
  /** Validates the spec and writes the per-sandbox launcher. */
  prepare(spec: SandboxSpec): PreparedSandbox;
}

/**
 * The highest network level a driver may be given (W-RUN 10.1): namespace
 * isolation (bwrap, single mode) is capped at `trusted`.
 */
export function maxNetworkLevel(isolation: IsolationStrength): NetworkLevel {
  return isolation === "gvisor" ? "full" : "trusted";
}

const NETWORK_ORDER: NetworkLevel[] = ["none", "trusted", "custom", "full"];

/** Lowers `wanted` to the driver's ceiling (custom counts as trusted plus extras). */
export function clampNetworkLevel(
  wanted: NetworkLevel,
  isolation: IsolationStrength,
): NetworkLevel {
  const max = maxNetworkLevel(isolation);
  return NETWORK_ORDER.indexOf(wanted) <= NETWORK_ORDER.indexOf(max)
    ? wanted
    : max;
}

// ---------------------------------------------------------------------------
// Spec validation

/** Paths the driver manages itself; mounts may not cover or sit inside them. */
export const RESERVED_SANDBOX_PATHS = [
  "/",
  "/proc",
  "/dev",
  "/sys",
  "/tmp",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/run/claudex",
];

/** The in-sandbox directory where bridge sockets appear. */
export const SANDBOX_RUN_DIR = "/run/claudex";

/** Default in-sandbox port of the egress proxy bridge (HTTPS_PROXY). */
export const DEFAULT_EGRESS_PORT = 3128;

/** Linux sun_path is 108 bytes including the terminator. */
const MAX_SOCKET_PATH = 107;

export class SandboxSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxSpecError";
  }
}

function isAbsoluteClean(p: string) {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    path.posix.isAbsolute(p) &&
    path.posix.normalize(p) === p &&
    !p.includes("\0") &&
    (p === "/" || !p.endsWith("/"))
  );
}

/** True when `child` is `parent` or lies inside it. */
export function within(child: string, parent: string) {
  if (parent === "/") return true;
  return child === parent || child.startsWith(parent + "/");
}

/** The in-sandbox path of a mount. */
export function sandboxPathOf(mount: SandboxMount) {
  return mount.sandbox ?? mount.host;
}

/**
 * Checks a spec before anything is written or run. Throws SandboxSpecError
 * with an English message naming the offending field.
 */
export function validateSpec(spec: SandboxSpec, opts: { fs?: boolean } = {}) {
  const checkFs = opts.fs ?? true;
  const fail = (m: string): never => {
    throw new SandboxSpecError(m);
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(spec.id ?? ""))
    fail("Sandbox id must be 1-63 letters, digits, '.', '_' or '-'.");
  if (!["chat", "cowork", "code"].includes(spec.kind))
    fail(`Unknown sandbox kind: ${String(spec.kind)}`);
  for (const [name, value] of [
    ["stateDir", spec.stateDir],
    ["codexBinary", spec.codexBinary],
    ["codexRoot", spec.codexRoot],
    ["node", spec.node],
    ["cwd", spec.cwd],
    ["home", spec.home],
    ["egress.socket", spec.egress?.socket],
    ...(spec.pathDirs ?? []).map((p, i) => [`pathDirs[${i}]`, p]),
  ] as Array<[string, string | undefined]>)
    if (value !== undefined && !isAbsoluteClean(value))
      fail(`${name} must be an absolute, normalized path.`);
  if (spec.stateDir === "/") fail("stateDir cannot be /.");
  // stateDir's parent holds every sandbox's state (specs, bridge sockets to
  // other users' provider services): nothing bound into the sandbox may
  // contain it, and it may not sit inside the read-only system directories.
  const stateRoot = path.dirname(spec.stateDir);
  if (
    [
      "/usr",
      "/bin",
      "/sbin",
      "/lib",
      "/lib32",
      "/lib64",
      "/libx32",
      "/etc",
    ].some((d) => within(spec.stateDir, d))
  )
    fail("stateDir cannot be inside a system directory.");
  const exposes = (dir: string) =>
    within(stateRoot, dir) || within(dir, spec.stateDir);
  if (!Array.isArray(spec.mounts) || spec.mounts.length === 0)
    fail("A sandbox needs at least one mount.");
  if (!spec.mounts.some((m) => m.writable))
    fail("A sandbox needs at least one writable mount.");
  const targets = new Set<string>();
  for (const [i, m] of spec.mounts.entries()) {
    const target = sandboxPathOf(m);
    if (!isAbsoluteClean(m.host) || !isAbsoluteClean(target))
      fail(`mounts[${i}] needs absolute, normalized host and sandbox paths.`);
    if (m.host === "/") fail(`mounts[${i}] cannot expose the host root.`);
    // Directly on (or above) a managed path is never allowed; below one only
    // where the driver mounts a fresh tmpfs first (/tmp).
    for (const reserved of RESERVED_SANDBOX_PATHS)
      if (
        within(reserved, target) ||
        (reserved !== "/" && reserved !== "/tmp" && within(target, reserved))
      )
        fail(`mounts[${i}] cannot be placed at ${target} (reserved).`);
    if (targets.has(target)) fail(`Two mounts share the path ${target}.`);
    targets.add(target);
    // The sandbox must never be able to edit its own launcher or spec, and
    // must not see the runner's private files.
    if (exposes(m.host))
      fail(`mounts[${i}] overlaps the runner-private stateDir.`);
    if (checkFs) {
      let st: fs.Stats | undefined;
      try {
        st = fs.statSync(m.host);
      } catch {
        fail(`mounts[${i}] host path does not exist: ${m.host}`);
      }
      if (!st!.isDirectory())
        fail(`mounts[${i}] host path is not a directory: ${m.host}`);
    }
  }
  const writable = spec.mounts.filter((m) => m.writable);
  for (const [name, dir] of [
    ["codexRoot", spec.codexRoot ?? path.dirname(spec.codexBinary)],
    ["node", path.dirname(spec.node ?? process.execPath)],
  ])
    if (writable.some((m) => within(dir, m.host) || within(m.host, dir)))
      fail(`${name} cannot overlap a writable mount.`);
  // These are bound read-only at their host paths.
  for (const [name, dir] of [
    ["codexRoot", spec.codexRoot ?? path.dirname(spec.codexBinary)],
    ["node", path.dirname(spec.node ?? process.execPath)],
    ...(spec.pathDirs ?? []).map((p, i) => [`pathDirs[${i}]`, p]),
  ] as Array<[string, string]>)
    if (dir === "/" || exposes(dir))
      fail(`${name} cannot expose the runner-private state.`);
  if (
    spec.cwd !== undefined &&
    !spec.mounts.some((m) => within(spec.cwd!, sandboxPathOf(m)))
  )
    fail("cwd must be inside one of the mounts.");
  if (spec.egress) {
    const port = spec.egress.port ?? DEFAULT_EGRESS_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      fail("egress.port must be a TCP port.");
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) fail(`Bad environment name ${k}.`);
    if (typeof v !== "string" || v.includes("\0"))
      fail(`Bad environment value for ${k}.`);
    if (isSecretEnvName(k) || RESERVED_ENV.has(k))
      fail(`The environment variable ${k} cannot be set on a sandbox.`);
  }
  const l = spec.limits ?? {};
  for (const [k, v] of Object.entries(l))
    if (v !== undefined && !(typeof v === "number" && v > 0 && isFinite(v)))
      fail(`limits.${k} must be a positive number.`);
  if (bridgeSocketPath(spec.stateDir, 1, 65535).length > MAX_SOCKET_PATH)
    fail("stateDir is too long for Unix socket paths.");
  return spec;
}

// ---------------------------------------------------------------------------
// Environment

/**
 * Names that look like credentials. Engine passes the runner's whole
 * environment to codex; only an allowlist crosses into the sandbox, and even
 * a spec cannot add names like these. The loopback gateway token is the one
 * exception (it only works against the per-user provider service).
 */
export function isSecretEnvName(name: string) {
  return /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/i.test(
    name,
  );
}

/** Set by the driver itself; a spec cannot override them. */
const RESERVED_ENV = new Set([
  "PATH",
  "HOME",
  "CODEX_HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_OPTIONS",
]);

/** Variables copied from Engine's environment into the sandbox. */
export const PASSED_ENV = ["CLAUDEX_GATEWAY_TOKEN", "LANG", "LC_ALL", "TZ"];

/** Host path of the bridge socket for one port of one launch. */
export function bridgeSocketPath(
  stateDir: string,
  launch: number,
  port: number,
) {
  return path.join(stateDir, "run", String(launch), `p${port}.sock`);
}
