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
import os from "node:os";
import path from "node:path";
import { validateSpec, SandboxSpecError } from "./driver.ts";
import { readSpec, writeLauncher } from "./sandbox-setup.ts";
import type {
  DriverCheck,
  PreparedSandbox,
  SandboxDriver,
  SandboxSpec,
} from "./driver.ts";
import { cgroupDir, readCgroupUsage } from "./quota.ts";
import type { CgroupUsage } from "./quota.ts";
import {
  readImageManifest,
  CONTAINER_PREFIX,
  containerId,
  runscSocketPathFits,
} from "./runsc-oci.ts";
import {
  type RunscDriverOptions,
  optionsToSpec,
  specOptions,
  cleanupCommands,
  execCommand,
  listCommand,
  launcherEnv,
  resolveTool,
  quiet,
  realRootfs,
  defaultWrapper,
} from "./runsc-commands.ts";
import { checkRunsc } from "./runsc-check.ts";
import { launch } from "./runsc-launch.ts";

export class RunscDriver implements SandboxDriver {
  readonly name = "runsc" as const;
  readonly isolation = "gvisor" as const;
  private opts: RunscDriverOptions;
  constructor(opts: RunscDriverOptions) {
    this.opts = opts;
  }

  /** The image manifest of the configured rootfs. */
  image() {
    return readImageManifest(this.opts.rootfs);
  }

  prepare(input: SandboxSpec): PreparedSandbox {
    const image = this.image();
    const rootfs = realRootfs(this.opts.rootfs);
    // codex comes from the image; another program the image has (git for
    // the Changes panel) runs as asked instead of codex.
    const other =
      input.codexBinary &&
      input.codexBinary !== image.codex &&
      path.posix.isAbsolute(input.codexBinary) &&
      fs.existsSync(path.join(rootfs, input.codexBinary))
        ? input.codexBinary
        : undefined;
    const spec: SandboxSpec = {
      ...input,
      // codex and Node come from the image; nothing of the host's is bound.
      codexBinary: image.codex,
      codexRoot: path.posix.dirname(path.posix.dirname(image.codex)),
      node: image.node,
      pathDirs: image.pathDirs,
      options: {
        ...optionsToSpec(this.opts),
        // Pin the image version this sandbox starts with (`current` may move).
        rootfs,
        ...(other ? { command: JSON.stringify([other]) } : {}),
        runsc: resolveTool(this.opts.runsc ?? "runsc"),
        ctr: resolveTool(this.opts.ctr ?? "ctr"),
        ...input.options,
      },
    };
    validateSpec(spec);
    specOptions(spec);
    if (!runscSocketPathFits(spec.stateDir))
      throw new SandboxSpecError("stateDir is too long for Unix socket paths.");
    return writeLauncher(
      spec,
      this.opts.wrapper ?? defaultWrapper(),
      this.opts.node ?? process.execPath,
    );
  }

  private resolved(spec?: SandboxSpec) {
    return specOptions(
      spec ?? ({ options: optionsToSpec(this.opts) } as SandboxSpec),
    );
  }

  /** Runs `argv` in the running sandbox (e.g. git status for the diff view). */
  exec(
    spec: SandboxSpec,
    argv: string[],
    opts: { cwd?: string; input?: string; timeoutMs?: number } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const o = this.resolved(spec);
    const cwd = opts.cwd ?? spec.cwd ?? "/workspace";
    const cmd = execCommand(o, containerId(spec), argv, cwd);
    return new Promise((resolve) => {
      const child = spawn(cmd[0], cmd.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        env: launcherEnv(),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(
        () => child.kill("SIGKILL"),
        opts.timeoutMs ?? 120_000,
      );
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: stderr + e.message });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          code: code ?? 128 + ((signal && os.constants.signals[signal]) || 0),
          stdout,
          stderr,
        });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input ?? "");
    });
  }

  /** Force-removes this sandbox's container (runner drain, stuck launches). */
  reap(spec: Pick<SandboxSpec, "id" | "options">) {
    const o = this.resolved(spec as SandboxSpec);
    for (const cmd of cleanupCommands(o, containerId(spec))) quiet(cmd);
  }

  /** Ids of this driver's containers that exist now (running or not). */
  list(): string[] {
    const r = quiet(listCommand(this.resolved()));
    if (r.status !== 0) return [];
    return r.stdout
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith(CONTAINER_PREFIX));
  }

  /** Removes every container of this driver (runner start-up after a crash). */
  reapAll() {
    const o = this.resolved();
    const ids = this.list();
    for (const id of ids) for (const cmd of cleanupCommands(o, id)) quiet(cmd);
    return ids;
  }

  /** cgroup usage of a running sandbox (memory, pids, CPU time). */
  usage(spec: Pick<SandboxSpec, "id" | "options">): CgroupUsage | undefined {
    const o = this.resolved(spec as SandboxSpec);
    if (o.ignoreCgroups) return undefined;
    return readCgroupUsage(
      cgroupDir(path.posix.join(o.cgroupParent, containerId(spec))),
    );
  }

  async check(opts: { smoke?: boolean } = {}): Promise<DriverCheck> {
    return checkRunsc(this.opts, opts);
  }
}

function parseLauncherArgs(argv: string[]) {
  const sep = argv.indexOf("--");
  const own = sep >= 0 ? argv.slice(0, sep) : argv;
  const args = sep >= 0 ? argv.slice(sep + 1) : [];
  const i = own.indexOf("--spec");
  const spec = i >= 0 ? own[i + 1] : undefined;
  if (!spec)
    throw new Error("usage: runsc.ts --spec <spec.json> -- <codex args>");
  return { specPath: spec, args };
}

/** The launcher program: codex JSON-RPC on stdio, diagnostics on stderr only. */
export async function main(
  argv: string[],
  engineEnv: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed: ReturnType<typeof parseLauncherArgs>;
  let spec: SandboxSpec;
  try {
    parsed = parseLauncherArgs(argv);
    spec = readSpec(parsed.specPath);
    if (spec.options?.driver !== "runsc")
      throw new SandboxSpecError("The spec is not for the runsc driver.");
  } catch (error) {
    process.stderr.write(`sandbox-codex: ${(error as Error).message}\n`);
    return 126;
  }
  try {
    const r = await launch(spec, parsed.args, engineEnv, { stdio: "relay" });
    // What codex wrote last reaches the engine before the process exits.
    await new Promise<void>((resolve) =>
      process.stdout.write("", () => resolve()),
    );
    return r.code;
  } catch (error) {
    process.stderr.write(`sandbox-codex: ${(error as Error).message}\n`);
    return 126;
  }
}
