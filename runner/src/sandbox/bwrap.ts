// bubblewrap sandbox driver: the `single` mode of the web runner. One sandbox
// per user for Chat; the sandbox has its own user, pid, net, ipc, uts and
// cgroup namespaces, sees only the system directories read-only plus the
// user's codex-home and workspace, and reaches the outside world only through
// Unix sockets the runner binds in (model gateway and egress proxy).
//
// Isolation is namespace-based, weaker than gVisor: the runner caps network
// at `trusted` (maxNetworkLevel) and single mode stays allowlist-only.
//
// The same file is the launcher's program: runner/bin/sandbox-codex calls
// `main()`, which Node runs through its own type stripping (erasable syntax
// only in this file and in driver.ts).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EGRESS_PORT,
  SANDBOX_RUN_DIR,
  sandboxPathOf,
  validateSpec,
  within,
} from "./driver.ts";
import {
  BRIDGE_SOURCE,
  listenUnixToTcp,
  loopbackPorts,
  readSpec,
  sandboxEnv,
  sandboxArgs,
  toSandboxPath,
  writeLauncher,
} from "./sandbox-setup.ts";
import { bridgeSocketPath } from "./driver.ts";
import type {
  DriverCheck,
  PreparedSandbox,
  SandboxDriver,
  SandboxLimits,
  SandboxSpec,
} from "./driver.ts";

/** uid/gid codex runs as inside the user namespace (mapped to the runner user). */
export const SANDBOX_UID = 1000;

/** Flags this driver relies on; bubblewrap 0.9.0 (Ubuntu 24.04) has them all. */
export const REQUIRED_BWRAP_FLAGS = [
  "--die-with-parent",
  "--new-session",
  "--unshare-all",
  "--unshare-user",
  "--cap-drop",
  "--clearenv",
  "--setenv",
  "--ro-bind",
  "--symlink",
  "--chdir",
  "--args",
];

/** System directories bound read-only (or recreated as symlinks on merged-/usr hosts). */
export const SYSTEM_DIRS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
];

/**
 * The only parts of the host's /etc the sandbox sees. The runner host keeps
 * its configuration (runner.env, nginx, database settings) in /etc, so /etc
 * is never bound as a whole; passwd and group are synthesized.
 */
export const ETC_ENTRIES = [
  "/etc/alternatives",
  "/etc/ca-certificates",
  "/etc/ca-certificates.conf",
  "/etc/ssl",
  "/etc/pki",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/localtime",
  "/etc/nsswitch.conf",
  "/etc/hosts",
  "/etc/os-release",
  "/etc/mime.types",
  "/etc/protocols",
  "/etc/services",
  "/etc/gitconfig",
];

export type PathKind = "dir" | "file" | "symlink" | "missing";

/** File system questions the argument builder asks (replaceable in tests). */
export interface HostProbe {
  kind(p: string): PathKind;
  readlink(p: string): string;
}

export const hostProbe: HostProbe = {
  kind(p) {
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) return "symlink";
      return st.isDirectory() ? "dir" : "file";
    } catch {
      return "missing";
    }
  },
  readlink(p) {
    return fs.readlinkSync(p);
  },
};

export interface BwrapLaunch {
  spec: SandboxSpec;
  /** Engine's arguments for codex (`app-server --listen stdio:// -c …`). */
  args: string[];
  /** Engine's environment (only an allowlist crosses into the sandbox). */
  engineEnv: NodeJS.ProcessEnv;
  /** Host directory holding this launch's bridge sockets. */
  launchDir: string;
  /** Loopback ports bridged into the sandbox (from `loopbackPorts(args)`). */
  ports: number[];
  probe?: HostProbe;
}

/** Directories covered by the system binds (no extra bind needed). */
function coveredBySystem(dir: string) {
  return SYSTEM_DIRS.some((s) => within(dir, s));
}

/**
 * The full bubblewrap command line for one launch: `bwrap <args>`.
 * Returns the arguments and the environment codex will see (for tests and
 * logs; the values are set inside the sandbox with --setenv).
 */
export function buildBwrapArgs(launch: BwrapLaunch) {
  const { spec, engineEnv, launchDir, ports } = launch;
  const args = sandboxArgs(spec.mounts, launch.args);
  const probe = launch.probe ?? hostProbe;
  const egressPort = spec.egress
    ? (spec.egress.port ?? DEFAULT_EGRESS_PORT)
    : undefined;
  const env = sandboxEnv(spec, engineEnv, { proxyPort: egressPort });
  const out: string[] = [
    "--die-with-parent",
    // No shared controlling terminal: blocks TIOCSTI keystroke injection.
    "--new-session",
    "--unshare-all",
    "--unshare-user",
    "--cap-drop",
    "ALL",
    "--uid",
    String(SANDBOX_UID),
    "--gid",
    String(SANDBOX_UID),
    "--hostname",
    "sandbox",
  ];
  for (const dir of SYSTEM_DIRS) {
    const kind = probe.kind(dir);
    if (kind === "dir") out.push("--ro-bind", dir, dir);
    else if (kind === "symlink")
      out.push("--symlink", probe.readlink(dir), dir);
  }
  for (const entry of ETC_ENTRIES)
    if (probe.kind(entry) !== "missing") out.push("--ro-bind", entry, entry);
  out.push(
    "--ro-bind",
    path.join(spec.stateDir, "etc", "passwd"),
    "/etc/passwd",
    "--ro-bind",
    path.join(spec.stateDir, "etc", "group"),
    "/etc/group",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  );
  // The codex package, Node for the bridge and extra PATH entries, read-only
  // at their host paths.
  const readOnly = new Set<string>();
  const node = spec.node ?? process.execPath;
  for (const dir of [
    spec.codexRoot ?? path.dirname(spec.codexBinary),
    path.dirname(node),
    ...(spec.pathDirs ?? []),
  ]) {
    if (coveredBySystem(dir)) continue;
    if ([...readOnly].some((r) => within(dir, r))) continue;
    readOnly.add(dir);
  }
  for (const dir of readOnly) out.push("--ro-bind", dir, dir);
  // User data. Shorter targets first so nested mounts land on top.
  const mounts = [...spec.mounts].sort(
    (a, b) => sandboxPathOf(a).length - sandboxPathOf(b).length,
  );
  for (const m of mounts)
    out.push(m.writable ? "--bind" : "--ro-bind", m.host, sandboxPathOf(m));
  // Bridge sockets last so nothing can shadow them. Read-only is enough:
  // connecting to a Unix socket does not need a writable mount.
  const forwards: Array<{ port: number; socket: string }> = [];
  if (ports.length) {
    out.push("--ro-bind", launchDir, `${SANDBOX_RUN_DIR}/fwd`);
    for (const port of ports)
      forwards.push({
        port,
        socket: `${SANDBOX_RUN_DIR}/fwd/p${port}.sock`,
      });
  }
  if (spec.egress && egressPort) {
    out.push("--ro-bind", spec.egress.socket, `${SANDBOX_RUN_DIR}/egress.sock`);
    forwards.push({
      port: egressPort,
      socket: `${SANDBOX_RUN_DIR}/egress.sock`,
    });
  }
  const cwd =
    spec.cwd !== undefined
      ? (toSandboxPath(spec.mounts, spec.cwd) ?? spec.cwd)
      : sandboxPathOf(spec.mounts.find((m) => m.writable)!);
  out.push("--chdir", cwd);
  // --clearenv takes effect where it appears, so it must precede --setenv.
  out.push("--clearenv");
  const inner = forwards.length
    ? [node, "-e", BRIDGE_SOURCE]
    : [spec.codexBinary, ...args];
  const innerEnv: Record<string, string> = { ...env };
  if (forwards.length)
    innerEnv.CLAUDEX_SANDBOX_BRIDGE = JSON.stringify({
      forwards,
      argv: [spec.codexBinary, ...args],
    });
  for (const [k, v] of Object.entries(innerEnv)) out.push("--setenv", k, v);
  // `options` may go through --args; bwrap reads the command only from argv.
  const options = [...out];
  out.push("--", ...inner);
  return { args: out, options, command: inner, env, forwards };
}

/** passwd/group for the sandbox user (the host's are never shown). */
export function writeIdentityFiles(spec: SandboxSpec, home: string) {
  const dir = path.join(spec.stateDir, "etc");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const u = SANDBOX_UID;
  fs.writeFileSync(
    path.join(dir, "passwd"),
    `root:x:0:0:root:/root:/usr/sbin/nologin\nsandbox:x:${u}:${u}:Claudex sandbox:${home}:/bin/sh\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n`,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(dir, "group"),
    `root:x:0:\nsandbox:x:${u}:\nnogroup:x:65534:\n`,
    { mode: 0o644 },
  );
}

/**
 * Optional cgroup limits through a transient systemd scope
 * (`options.cgroup = "systemd-run"`); needs a user systemd manager with
 * delegated memory/pids/cpu controllers (Ubuntu 24.04 with systemd has it;
 * elsewhere enable lingering for the runner user).
 */
export function limitPrefix(
  limits: SandboxLimits | undefined,
  mode: string | undefined,
  systemdRun = "systemd-run",
) {
  if (mode !== "systemd-run" || !limits) return [];
  const props: string[] = [];
  if (limits.memoryMb)
    props.push(`MemoryMax=${Math.floor(limits.memoryMb)}M`, "MemorySwapMax=0");
  if (limits.pids) props.push(`TasksMax=${Math.floor(limits.pids)}`);
  if (limits.cpus) props.push(`CPUQuota=${Math.round(limits.cpus * 100)}%`);
  if (!props.length) return [];
  return [
    systemdRun,
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    ...props.flatMap((p) => ["-p", p]),
    "--",
  ];
}

/** Environment for the bwrap (or systemd-run) process itself; bwrap clears it for codex. */
function launcherEnv() {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  };
  for (const k of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"])
    if (process.env[k]) env[k] = process.env[k];
  return env;
}

function defaultWrapper() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../bin/sandbox-codex",
  );
}

export interface BwrapDriverOptions {
  /** bubblewrap executable (default `bwrap` on PATH). */
  bwrap?: string;
  /** Launcher program (default runner/bin/sandbox-codex next to this file). */
  wrapper?: string;
  /** Node that runs the launcher and the in-sandbox bridge. */
  node?: string;
  /** "systemd-run" enforces spec.limits in a transient scope; "none" does not. */
  cgroup?: "systemd-run" | "none";
  systemdRun?: string;
}

export class BwrapDriver implements SandboxDriver {
  readonly name = "bwrap" as const;
  readonly isolation = "namespaces" as const;
  private opts: BwrapDriverOptions;
  constructor(opts: BwrapDriverOptions = {}) {
    this.opts = opts;
  }

  prepare(input: SandboxSpec): PreparedSandbox {
    const spec: SandboxSpec = {
      ...input,
      node: input.node ?? this.opts.node,
      options: {
        bwrap: this.opts.bwrap,
        cgroup: this.opts.cgroup,
        systemdRun: this.opts.systemdRun,
        ...input.options,
      },
    };
    validateSpec(spec);
    writeIdentityFiles(spec, spec.home ?? "/tmp"); // rewritten with the real HOME at launch
    return writeLauncher(
      spec,
      this.opts.wrapper ?? defaultWrapper(),
      this.opts.node ?? process.execPath,
    );
  }

  async check(): Promise<DriverCheck> {
    return checkBwrap(this.opts);
  }
}

/** Host readiness for the bwrap driver: platform, version, flags, a smoke run. */
export function checkBwrap(opts: BwrapDriverOptions = {}): DriverCheck {
  const result: DriverCheck = {
    ok: false,
    driver: "bwrap",
    problems: [],
    warnings: [
      "bubblewrap isolates with kernel namespaces only; keep single mode allowlist-only with network at most trusted.",
    ],
  };
  if (process.platform !== "linux") {
    result.problems.push("The bwrap driver needs Linux.");
    return result;
  }
  const bwrap = opts.bwrap ?? "bwrap";
  const version = spawnSync(bwrap, ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) {
    result.problems.push(
      `bubblewrap is not installed or not runnable (${bwrap}).`,
    );
    return result;
  }
  result.version = version.stdout.trim().replace(/^bubblewrap\s+/, "");
  const help = spawnSync(bwrap, ["--help"], { encoding: "utf8" });
  const text = `${help.stdout}${help.stderr}`;
  const missing = REQUIRED_BWRAP_FLAGS.filter((f) => !text.includes(f));
  if (missing.length)
    result.problems.push(
      `bubblewrap ${result.version} lacks ${missing.join(", ")}; install 0.9.0 or later.`,
    );
  const probe: string[] = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--unshare-user",
    "--cap-drop",
    "ALL",
  ];
  for (const dir of SYSTEM_DIRS) {
    const kind = hostProbe.kind(dir);
    if (kind === "dir") probe.push("--ro-bind", dir, dir);
    else if (kind === "symlink")
      probe.push("--symlink", hostProbe.readlink(dir), dir);
  }
  probe.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--",
    "/bin/sh",
    "-c",
    "exit 0",
  );
  const smoke = spawnSync(bwrap, probe, {
    encoding: "utf8",
    env: launcherEnv(),
    timeout: 20000,
  });
  if (smoke.status !== 0)
    result.problems.push(
      `bubblewrap cannot create a sandbox: ${(smoke.stderr || smoke.error?.message || "").trim().slice(0, 300)}. ` +
        "Unprivileged user namespaces must be allowed (sysctl kernel.unprivileged_userns_clone=1; on Ubuntu 24.04 also kernel.apparmor_restrict_unprivileged_userns=0 or an AppArmor profile for bwrap).",
    );
  if (opts.cgroup === "systemd-run") {
    const run = spawnSync(
      opts.systemdRun ?? "systemd-run",
      [
        ...limitPrefix({ memoryMb: 64, pids: 16 }, "systemd-run").slice(1),
        "/bin/sh",
        "-c",
        "exit 0",
      ],
      { encoding: "utf8", env: launcherEnv(), timeout: 20000 },
    );
    if (run.status !== 0)
      result.problems.push(
        `systemd-run cannot create a limited scope: ${(run.stderr || run.error?.message || "").trim().slice(0, 300)}. Enable a user systemd manager (loginctl enable-linger) or set cgroup to none.`,
      );
  } else {
    result.warnings.push(
      "Resource limits are not enforced (cgroup mode none); set cgroup to systemd-run on hosts with a user systemd manager.",
    );
  }
  result.ok = result.problems.length === 0;
  return result;
}

// ---------------------------------------------------------------------------
// Launcher program (runner/bin/sandbox-codex)

function parseLauncherArgs(argv: string[]) {
  const sep = argv.indexOf("--");
  const own = sep >= 0 ? argv.slice(0, sep) : argv;
  const args = sep >= 0 ? argv.slice(sep + 1) : [];
  const i = own.indexOf("--spec");
  const spec = i >= 0 ? own[i + 1] : undefined;
  if (!spec)
    throw new Error("usage: sandbox-codex --spec <spec.json> -- <codex args>");
  return { specPath: spec, args };
}

/**
 * Runs codex in the sandbox described by the spec, with Engine's arguments,
 * stdio passed straight through (JSON-RPC on stdin/stdout). Resolves to the
 * exit status. Never writes to stdout itself.
 */
export async function main(
  argv: string[],
  engineEnv: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed: ReturnType<typeof parseLauncherArgs>;
  let spec: SandboxSpec;
  try {
    parsed = parseLauncherArgs(argv);
    spec = readSpec(parsed.specPath);
  } catch (error) {
    process.stderr.write(`sandbox-codex: ${(error as Error).message}\n`);
    return 126;
  }
  const opts = spec.options ?? {};
  const launchDir = path.join(spec.stateDir, "run", String(process.pid));
  const servers: net.Server[] = [];
  const cleanup = () => {
    for (const s of servers) s.close();
    fs.rmSync(launchDir, { recursive: true, force: true });
  };
  try {
    fs.mkdirSync(launchDir, { recursive: true, mode: 0o700 });
    const ports = loopbackPorts(parsed.args);
    for (const port of ports)
      servers.push(
        await listenUnixToTcp(
          bridgeSocketPath(spec.stateDir, process.pid, port),
          port,
        ),
      );
    const {
      options,
      command: inner,
      env,
    } = buildBwrapArgs({
      spec,
      args: parsed.args,
      engineEnv,
      launchDir,
      ports,
    });
    // HOME lives on a writable mount; create it on the host side.
    const hostHome = engineEnv.CODEX_HOME;
    if (hostHome && env.HOME === `${env.CODEX_HOME}/home`)
      fs.mkdirSync(path.join(hostHome, "home"), {
        recursive: true,
        mode: 0o700,
      });
    writeIdentityFiles(spec, env.HOME);
    removeHostWriteTraps(hostHome);
    // The options carry the loopback token (--setenv); they go through a
    // pipe (--args 3) so they never show in the host's /proc/<pid>/cmdline.
    const command = [
      ...limitPrefix(spec.limits, opts.cgroup, opts.systemdRun),
      opts.bwrap || "bwrap",
      "--args",
      "3",
      "--",
      ...inner,
    ];
    const child = spawn(command[0], command.slice(1), {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      env: launcherEnv(),
    });
    const argsPipe = child.stdio[3] as Writable;
    argsPipe.on("error", () => {}); // bwrap reports its own failures
    argsPipe.end(Buffer.from(options.map((a) => `${a}\0`).join("")));
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
    const forward = (s: NodeJS.Signals) => {
      try {
        child.kill(s);
      } catch {}
    };
    for (const s of signals) process.on(s, forward);
    const code = await new Promise<number>((resolve) => {
      child.once("error", (error) => {
        process.stderr.write(`sandbox-codex: ${error.message}\n`);
        resolve(127);
      });
      child.once("exit", (status, signal) =>
        resolve(
          status ?? 128 + ((signal && os.constants.signals[signal]) || 0),
        ),
      );
    });
    for (const s of signals) process.off(s, forward);
    return code;
  } catch (error) {
    process.stderr.write(`sandbox-codex: ${(error as Error).message}\n`);
    return 126;
  } finally {
    cleanup();
    // Every process of the sandbox is gone with its pid namespace, so no
    // new trap can appear before Engine's next start.
    try {
      removeHostWriteTraps(engineEnv.CODEX_HOME);
    } catch {}
  }
}

/**
 * Files in the writable mounts that the host side (Engine) writes before it
 * starts codex. The sandbox could replace one with a symlink to a runner or
 * another user's file, and the next host write would follow it; a symlink (or
 * anything but a regular file) there is removed. Engine must still treat
 * everything else in codex-home and workspace as untrusted input.
 */
export const HOST_WRITTEN_FILES = ["config.toml"];

export function removeHostWriteTraps(codexHome: string | undefined) {
  if (!codexHome) return;
  for (const name of HOST_WRITTEN_FILES) {
    const file = path.join(codexHome, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (st.isFile()) continue;
    process.stderr.write(
      `sandbox-codex: removed ${st.isSymbolicLink() ? "a symlink" : "a non-file"} at ${file}\n`,
    );
    fs.rmSync(file, { recursive: true, force: true });
  }
}
