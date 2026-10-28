import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shQuote } from "./sandbox-setup.ts";
import type { DriverCheck, SandboxSpec } from "./driver.ts";
import { checkCgroups } from "./quota.ts";
import { type SandboxImage, readImageManifest, inRootfs } from "./runsc-oci.ts";
import {
  type RunscDriverOptions,
  optionsToSpec,
  specOptions,
  ctrBase,
  quiet,
} from "./runsc-commands.ts";
import { specOptionsFor, launch } from "./runsc-launch.ts";

/** Keys the shim's runsc.toml must set for our isolation model. */
export function checkRuntimeConfig(text: string): string[] {
  const problems: string[] = [];
  const section = /\[runsc_config\]([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1] ?? "";
  const value = (key: string) =>
    new RegExp(`^\\s*"?${key}"?\\s*=\\s*"([^"]*)"`, "m").exec(section)?.[1];
  if (value("network") !== "none")
    problems.push('runsc.toml must set network = "none" under [runsc_config].');
  if (value("host-uds") !== "open")
    problems.push(
      'runsc.toml must set host-uds = "open" under [runsc_config] (bridge sockets).',
    );
  return problems;
}

/** Host readiness: image, runtime binaries, cgroups, optionally a real sandbox. */
export async function checkRunsc(
  opts: RunscDriverOptions,
  run: { smoke?: boolean } = {},
): Promise<DriverCheck> {
  const engine = opts.engine ?? "runsc";
  const result: DriverCheck = {
    ok: false,
    driver: "runsc",
    problems: [],
    warnings: [],
  };
  if (process.platform !== "linux") {
    result.problems.push("The runsc driver needs Linux.");
    return result;
  }
  let image: SandboxImage | undefined;
  try {
    image = readImageManifest(opts.rootfs);
    const codex = inRootfs(opts.rootfs, image.codex);
    if (!fs.existsSync(codex))
      result.problems.push(`The sandbox image has no codex at ${image.codex}.`);
    else if (opts.verifyImage !== false) {
      const h = crypto.createHash("sha256");
      const fd = fs.openSync(codex, "r");
      try {
        const buf = Buffer.alloc(4 * 1024 * 1024);
        for (;;) {
          const n = fs.readSync(fd, buf, 0, buf.length, null);
          if (n <= 0) break;
          h.update(buf.subarray(0, n));
        }
      } finally {
        fs.closeSync(fd);
      }
      if (h.digest("hex") !== image.codexSha256)
        result.problems.push(
          "The codex binary in the sandbox image does not match its pinned checksum.",
        );
    }
    if (!fs.existsSync(inRootfs(opts.rootfs, image.node)))
      result.problems.push(`The sandbox image has no Node at ${image.node}.`);
  } catch (error) {
    result.problems.push((error as Error).message);
  }
  const runsc = opts.runsc ?? "runsc";
  const v = quiet([runsc, "--version"]);
  if (v.status === 0) {
    result.version =
      /runsc version (\S+)/.exec(v.stdout)?.[1] ?? v.stdout.split("\n")[0];
    // 2026-09 releases start the sentry from gvisor-bin/ next to runsc.
    const which = quiet(["sh", "-c", `command -v ${shQuote(runsc)}`]);
    const real = which.status === 0 ? which.stdout.trim() : runsc;
    try {
      const dir = path.dirname(fs.realpathSync(real));
      if (!fs.existsSync(path.join(dir, "gvisor-bin")))
        result.warnings.push(
          "No gvisor-bin/ directory next to runsc; install the whole gVisor release archive.",
        );
    } catch {}
  } else if (engine === "runsc") {
    result.problems.push(`runsc is not installed or not runnable (${runsc}).`);
  } else {
    result.warnings.push(
      "runsc is not on the runner's PATH (the containerd shim still needs it).",
    );
  }
  if (engine === "containerd") {
    const o = specOptions({
      options: optionsToSpec(opts),
    } as SandboxSpec);
    const ver = quiet([...ctrBase(o), "version"]);
    if (ver.status !== 0)
      result.problems.push(
        `containerd is not reachable with ${o.ctr}: ${(ver.stderr || ver.error?.message || "").trim().slice(0, 200)}. The runner user needs access to the containerd socket.`,
      );
    const shim = quiet(["sh", "-c", "command -v containerd-shim-runsc-v1"]);
    if (shim.status !== 0)
      result.problems.push(
        "containerd-shim-runsc-v1 is not on PATH (it ships with the gVisor release).",
      );
    if (!opts.runtimeConfig)
      result.problems.push(
        "Set runtimeConfig to the runsc.toml that turns off the sandbox network.",
      );
    else {
      try {
        result.problems.push(
          ...checkRuntimeConfig(fs.readFileSync(opts.runtimeConfig, "utf8")),
        );
      } catch {
        result.problems.push(`Cannot read ${opts.runtimeConfig}.`);
      }
    }
  }
  if (engine === "runsc" && opts.ignoreCgroups)
    result.warnings.push(
      "cgroups are ignored: sandbox memory, pids and CPU limits are not enforced.",
    );
  else result.problems.push(...checkCgroups());
  if (run.smoke && result.problems.length === 0 && image) {
    const smoke = await smokeTest(opts);
    if (!smoke.ok)
      result.problems.push(`A test sandbox failed: ${smoke.detail}`);
  }
  result.ok = result.problems.length === 0;
  return result;
}

/** Starts a throwaway sandbox running `sh -c "exit 0"`. */
export async function smokeTest(
  opts: RunscDriverOptions,
): Promise<{ ok: boolean; detail: string }> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-smoke-"));
  try {
    const data = path.join(base, "d");
    fs.mkdirSync(data, { mode: 0o700 });
    const image = readImageManifest(opts.rootfs);
    const spec = specOptionsFor(opts, {
      id: `smoke-${process.pid}`,
      kind: "chat",
      stateDir: path.join(base, "s"),
      codexBinary: image.codex,
      mounts: [{ host: data, sandbox: "/workspace", writable: true }],
      cwd: "/workspace",
      limits: { memoryMb: 256, pids: 64, cpus: 0.5 },
    });
    const r = await launch(
      spec,
      ["-c", "exit 0"],
      { CODEX_HOME: data },
      {
        command: ["/bin/sh"],
        stdio: "pipe",
      },
    );
    return {
      ok: r.code === 0,
      detail: r.stderr.trim().slice(0, 300) || `exit ${r.code}`,
    };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
