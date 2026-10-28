import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  SANDBOX_CLASSES,
  SandboxSpecError,
  within,
  sandboxPathOf,
  validateSpec,
  PASSED_ENV,
} from "./driver.ts";
import type {
  SandboxMount,
  SandboxLimits,
  SandboxSpec,
  PreparedSandbox,
} from "./driver.ts";

/**
 * Maps a host path to its in-sandbox path through the mounts (longest match
 * first). Returns undefined when the path is not visible in the sandbox.
 */
export function toSandboxPath(mounts: SandboxMount[], hostPath: string) {
  const sorted = [...mounts].sort((a, b) => b.host.length - a.host.length);
  for (const m of sorted)
    if (within(hostPath, m.host))
      return sandboxPathOf(m) + hostPath.slice(m.host.length);
  return undefined;
}

/**
 * The environment codex sees inside the sandbox, built from Engine's
 * environment and the spec. Throws when CODEX_HOME is not on a writable mount.
 */
export function sandboxEnv(
  spec: SandboxSpec,
  engineEnv: NodeJS.ProcessEnv,
  extra: { proxyPort?: number } = {},
) {
  const hostHome = engineEnv.CODEX_HOME;
  if (!hostHome) throw new SandboxSpecError("CODEX_HOME is not set.");
  const writable = spec.mounts.filter((m) => m.writable);
  const codexHome = toSandboxPath(writable, path.resolve(hostHome));
  if (!codexHome)
    throw new SandboxSpecError(
      "CODEX_HOME must be inside a writable sandbox mount.",
    );
  const pathDirs = [
    ...(spec.pathDirs ?? []),
    path.dirname(spec.node ?? process.execPath),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ];
  const env: Record<string, string> = {
    PATH: [...new Set(pathDirs)].join(":"),
    HOME: spec.home ?? `${codexHome}/home`,
    CODEX_HOME: codexHome,
    USER: "sandbox",
    LOGNAME: "sandbox",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    TERM: "dumb",
  };
  for (const name of PASSED_ENV) {
    const v = engineEnv[name];
    if (typeof v === "string" && v !== "") env[name] = v;
  }
  if (extra.proxyPort) {
    const proxy = `http://127.0.0.1:${extra.proxyPort}`;
    Object.assign(env, {
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    });
  }
  Object.assign(env, spec.env ?? {});
  return env;
}

// ---------------------------------------------------------------------------
// Loopback bridges

/**
 * Loopback TCP ports codex must reach, found in its arguments (Engine puts
 * the provider service's `base_url = "http://127.0.0.1:<port>/v1"` in a -c
 * override). Inside the sandbox the same port is served by a bridge to a Unix
 * socket, so the arguments stay unchanged.
 */
export function loopbackPorts(args: string[]) {
  const ports = new Set<number>();
  const re =
    /\bhttps?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(?=[/"'\s,}]|$)/g;
  for (const a of args)
    for (const m of a.matchAll(re)) {
      const port = Number(m[1]);
      if (port > 0 && port < 65536) ports.add(port);
    }
  return [...ports].sort((a, b) => a - b);
}

/**
 * Engine's codex arguments with the host path of a file it wrote into
 * CODEX_HOME (the model catalog, `-c model_catalog_json="…"`) mapped to
 * where that folder is mounted inside the sandbox (/codex-home in
 * production). Codex wants an absolute path; other arguments pass as they are.
 */
export function sandboxArgs(mounts: SandboxMount[], args: string[]) {
  return args.map((arg) => {
    const match = /^model_catalog_json=(".*")$/.exec(arg);
    if (!match) return arg;
    let host: unknown;
    try {
      host = JSON.parse(match[1]);
    } catch {
      return arg;
    }
    const inside =
      typeof host === "string" ? toSandboxPath(mounts, host) : undefined;
    return inside ? `model_catalog_json=${JSON.stringify(inside)}` : arg;
  });
}

/**
 * Host side of a bridge: a Unix socket server whose connections are piped to
 * 127.0.0.1:<port>. Only the ports discovered in codex's arguments are served.
 */
export function listenUnixToTcp(
  socketPath: string,
  port: number,
  host = "127.0.0.1",
): Promise<net.Server> {
  try {
    fs.unlinkSync(socketPath);
  } catch {}
  const server = net.createServer((client) => {
    const upstream = net.connect(port, host);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/**
 * The in-sandbox bridge, run as `node -e BRIDGE_SOURCE`. It listens on
 * 127.0.0.1:<port> for each forward, pipes connections to the matching Unix
 * socket, then runs codex with inherited stdio and exits with its status.
 * Configuration arrives in CLAUDEX_SANDBOX_BRIDGE (removed before codex runs).
 * CommonJS on purpose: `node -e` needs no module flags that way.
 */
export const BRIDGE_SOURCE = `"use strict";
const net = require("net"), cp = require("child_process"), os = require("os");
const cfg = JSON.parse(process.env.CLAUDEX_SANDBOX_BRIDGE || "{}");
delete process.env.CLAUDEX_SANDBOX_BRIDGE;
const forwards = cfg.forwards || [];
let pending = forwards.length, child;
function run() {
  child = cp.spawn(cfg.argv[0], cfg.argv.slice(1), { stdio: "inherit" });
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.on(s, () => { try { child.kill(s); } catch (e) {} });
  child.on("error", (e) => { process.stderr.write("sandbox: " + e.message + "\\n"); process.exit(127); });
  child.on("exit", (code, sig) => process.exit(code !== null ? code : 128 + (os.constants.signals[sig] || 0)));
}
for (const f of forwards) {
  const server = net.createServer((c) => {
    const u = net.connect(f.socket);
    c.pipe(u).pipe(c);
    const close = () => { c.destroy(); u.destroy(); };
    c.on("error", close); u.on("error", close); c.on("close", close); u.on("close", close);
  });
  server.on("error", (e) => { process.stderr.write("sandbox bridge: " + e.message + "\\n"); process.exit(1); });
  server.listen(f.port, "127.0.0.1", () => { if (--pending === 0) run(); });
}
if (pending === 0) run();
`;

// ---------------------------------------------------------------------------
// Standard layouts

/**
 * A sandbox's folder or socket name: the id itself while it is short, else a
 * short hash of it. A space's id (`space-<user>-c-<uuid>`) would make the
 * sandbox's socket paths longer than Linux allows (107 bytes).
 */
export function sandboxFileName(id: string) {
  const safe = id.replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe.length <= 24
    ? safe
    : `x-${createHash("sha256").update(id).digest("hex").slice(0, 20)}`;
}

/**
 * The per-user Chat sandbox of single mode: the user's Engine store root
 * keeps `codex-home` and `workspace` (Engine's own layout), both mounted at
 * their host paths so every path Engine and codex exchange over JSON-RPC
 * means the same file on both sides. The rest of the store root (settings,
 * provider-service vault) stays outside the sandbox.
 */
export function chatSandboxSpec(input: {
  env?: Record<string, string>;
  userId: string | number;
  /** The sandbox's id; defaults to `chat-<user id>` (an isolated space has its own). */
  id?: string;
  /** The user's Engine store root (Engine uses `<root>/codex-home`, `<root>/workspace`). */
  storeRoot: string;
  /** User-shared Codex .tmp, including its cross-process sync lock. */
  codexCache?: string;
  /** Runner-private directory; the launcher lives in `<stateRoot>/<id>`. */
  stateRoot: string;
  codexBinary: string;
  codexRoot?: string;
  pathDirs?: string[];
  egressSocket?: string;
  /** Extra read-only directories (e.g. staged attachments). */
  readOnly?: string[];
  limits?: SandboxLimits;
  options?: Record<string, string | undefined>;
}): SandboxSpec {
  const id = (input.id ?? `chat-${String(input.userId)}`).replace(
    /[^A-Za-z0-9_.-]/g,
    "_",
  );
  const home = path.join(input.storeRoot, "codex-home");
  const workspace = path.join(input.storeRoot, "workspace");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  return {
    id,
    kind: "chat",
    env: input.env,
    stateDir: path.join(input.stateRoot, sandboxFileName(id)),
    codexBinary: input.codexBinary,
    codexRoot: input.codexRoot,
    pathDirs: input.pathDirs,
    mounts: [
      { host: workspace, writable: true },
      { host: home, writable: true },
      ...(input.codexCache ? [{ host: input.codexCache, writable: true }] : []),
      ...(input.readOnly ?? []).map((host) => ({ host, writable: false })),
    ],
    codexCache: input.codexCache,
    cwd: workspace,
    egress: input.egressSocket ? { socket: input.egressSocket } : undefined,
    // W-RUN 4.1 chat class; single mode caps the one sandbox at 768 MiB.
    limits: input.limits ?? { memoryMb: 768, pids: 256, cpus: 1 },
    options: input.options,
  };
}

/** Fixed in-sandbox paths of the production layout (W-SPIKE conclusion 4). */
export const SANDBOX_WORKSPACE = "/workspace";

export const SANDBOX_CODEX_HOME = "/codex-home";

/** Host directories of one sandbox's persistent data (what snapshots contain). */
export function sandboxDataLayout(dataDir: string) {
  return {
    dataDir,
    workspace: path.join(dataDir, "workspace"),
    codexHome: path.join(dataDir, "codex-home"),
  };
}

/**
 * The production layout (runsc driver): one data directory per sandbox,
 * usually a disk-quota volume (quota.ts), holding `workspace` and
 * `codex-home`, mounted at the fixed paths /workspace and /codex-home so a
 * snapshot can be restored on another runner or under another host path.
 * Engine keeps using host paths; the driver maps CODEX_HOME, and the runner's
 * launcher (W-CODEENG) maps the cwd it sends over JSON-RPC with
 * `toSandboxPath`.
 */
export function workspaceSandboxSpec(input: {
  /** Stable sandbox id, e.g. `code-<conversation id>` or `chat-<user id>`. */
  id: string;
  kind: SandboxSpec["kind"];
  /** Host directory for this sandbox's data (created when missing). */
  dataDir: string;
  codexCache?: string;
  /** Runner-private directory; the launcher lives in `<stateRoot>/<id>`. */
  stateRoot: string;
  /** In-sandbox codex path (the runsc driver takes it from the image manifest). */
  codexBinary?: string;
  egressSocket?: string;
  /** Extra read-only host directories, mounted at `/mnt/ro/<n>`. */
  readOnly?: string[];
  env?: Record<string, string>;
  /** Defaults to the class limits of W-RUN 4.1. */
  limits?: SandboxLimits;
  options?: Record<string, string | undefined>;
}): SandboxSpec {
  const layout = sandboxDataLayout(input.dataDir);
  for (const d of [layout.dataDir, layout.workspace, layout.codexHome])
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return {
    id: input.id,
    kind: input.kind,
    stateDir: path.join(input.stateRoot, input.id),
    codexBinary: input.codexBinary ?? "/opt/claudex/codex/bin/codex",
    mounts: [
      { host: layout.workspace, sandbox: SANDBOX_WORKSPACE, writable: true },
      { host: layout.codexHome, sandbox: SANDBOX_CODEX_HOME, writable: true },
      ...(input.codexCache ? [{ host: input.codexCache, writable: true }] : []),
      ...(input.readOnly ?? []).map((host, i) => ({
        host,
        sandbox: `/mnt/ro/${i}`,
        writable: false,
      })),
    ],
    cwd: SANDBOX_WORKSPACE,
    codexCache: input.codexCache,
    egress: input.egressSocket ? { socket: input.egressSocket } : undefined,
    env: input.env,
    limits: input.limits ?? { ...SANDBOX_CLASSES[input.kind] },
    options: input.options,
  };
}

/**
 * Host side of a Unix-to-Unix relay: connections to `socketPath` are piped to
 * `target`. The runsc driver binds only its per-launch directory into the
 * sandbox and relays the egress proxy socket from there.
 */
export function listenUnixToUnix(
  socketPath: string,
  target: string,
): Promise<net.Server> {
  try {
    fs.unlinkSync(socketPath);
  } catch {}
  const server = net.createServer((client) => {
    const upstream = net.connect(target);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** Quotes a string for /bin/sh. */
export function shQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Writes the spec (0600) and the launcher (0700) into stateDir. The launcher
 * is what Engine spawns: it runs `wrapper --spec <file> -- <codex args>`.
 */
export function writeLauncher(
  spec: SandboxSpec,
  wrapper: string,
  node = process.execPath,
): PreparedSandbox {
  fs.mkdirSync(spec.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(spec.stateDir, 0o700);
  const specPath = path.join(spec.stateDir, "spec.json");
  const binary = path.join(spec.stateDir, "codex");
  const tmp = `${specPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(spec, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, specPath);
  const script =
    "#!/bin/sh\n" +
    `# Claudex runner: codex in sandbox ${spec.id} (generated; do not edit)\n` +
    // Engine hands over the runner's environment; its Node options are not
    // meant for the launcher.
    "unset NODE_OPTIONS NODE_PATH\n" +
    `exec ${shQuote(node)} --disable-warning=ExperimentalWarning ${shQuote(wrapper)} --spec ${shQuote(specPath)} -- "$@"\n`;
  const tmpBin = `${binary}.${process.pid}.tmp`;
  fs.writeFileSync(tmpBin, script, { mode: 0o700 });
  fs.renameSync(tmpBin, binary);
  return {
    binary,
    specPath,
    spec,
    dispose() {
      for (const f of [binary, specPath])
        try {
          fs.unlinkSync(f);
        } catch {}
      fs.rmSync(path.join(spec.stateDir, "run"), {
        recursive: true,
        force: true,
      });
    },
  };
}

/**
 * Reads a spec written by writeLauncher. Refuses files another user owns or
 * that group/others can write, since the spec decides what the sandbox sees.
 */
export function readSpec(specPath: string): SandboxSpec {
  const st = fs.statSync(specPath);
  if (typeof process.getuid === "function" && st.uid !== process.getuid())
    throw new SandboxSpecError("The sandbox spec is owned by another user.");
  if (st.mode & 0o022)
    throw new SandboxSpecError("The sandbox spec is writable by others.");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as SandboxSpec;
  return validateSpec(spec);
}
