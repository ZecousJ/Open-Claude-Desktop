import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type { Mode } from "../../shared/types";
import { resolveRuntime } from "../../electron/engine/runtime";
import { type NetPolicy } from "./net-policy";
import { parseNetConfig } from "./net-policy-compile";

export interface RunnerConfig {
  serviceUrl: string;
  publicUrl?: string;
  token: string;
  stateDir: string;
  driver: "bwrap" | "runsc" | "none";
  cgroup: "none" | "systemd-run";
  /** gVisor (driver runsc): the unpacked sandbox image and how runsc runs. */
  runsc?: {
    rootfs: string;
    runsc: string;
    platform: string;
    /** runsc and the quota tools through `sudo -n` (the runner is not root). */
    sudo: boolean;
  };
  /** Each user's sandbox: CPU cores, processes and its data's disk space. */
  cpus: number;
  pids: number;
  diskMb: number;
  /** How the disk space is enforced (quota.ts): none, loop, xfs-project or soft. */
  diskQuota: "none" | "loop" | "xfs-project" | "soft";
  codexBinary: string;
  codexRoot?: string;
  pathDirs: string[];
  providerServiceScript: string;
  wrapper?: string;
  /** The gVisor launcher (default: sandbox-runsc.mjs next to this bundle). */
  runscWrapper?: string;
  egressSocket?: string;
  /** Policy of the runner's own egress proxy (W-EGRESS). */
  network: NetPolicy;
  networkWarnings: string[];
  maxEngines: number;
  maxUsers: number;
  memoryMb: number;
  modes: Mode[];
  labels: Record<string, string>;
}

/** Reads the runner's configuration; throws a readable error when it is wrong. */
export function parseConfig(
  env: NodeJS.ProcessEnv,
  base: string = here(),
): RunnerConfig {
  const serviceUrl = (env.CLAUDEX_RUNNER_SERVICE_URL ?? "").replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(serviceUrl);
  } catch {
    throw new Error(
      "Set CLAUDEX_RUNNER_SERVICE_URL to the Claudex service address.",
    );
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
    parsed.hostname,
  );
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && loopback)
  )
    throw new Error(
      "CLAUDEX_RUNNER_SERVICE_URL must use https (http only on this machine).",
    );
  let token = env.CLAUDEX_RUNNER_TOKEN ?? "";
  if (env.CLAUDEX_RUNNER_TOKEN_FILE)
    token = fs.readFileSync(env.CLAUDEX_RUNNER_TOKEN_FILE, "utf8").trim();
  if (!/^[\x21-\x7e]{16,512}$/.test(token))
    throw new Error(
      "Set CLAUDEX_RUNNER_TOKEN_FILE to the runner token from the service's Runners page.",
    );
  const driver = (env.CLAUDEX_RUNNER_DRIVER ??
    "bwrap") as RunnerConfig["driver"];
  if (driver !== "bwrap" && driver !== "runsc" && driver !== "none")
    throw new Error("CLAUDEX_RUNNER_DRIVER must be runsc, bwrap or none.");
  const diskQuota = (env.CLAUDEX_RUNNER_DISK_QUOTA ??
    "none") as RunnerConfig["diskQuota"];
  if (!["none", "loop", "xfs-project", "soft"].includes(diskQuota))
    throw new Error(
      "CLAUDEX_RUNNER_DISK_QUOTA must be none, loop, xfs-project or soft.",
    );
  const cpus = Number(env.CLAUDEX_RUNNER_CPUS || "1");
  if (!(cpus > 0 && cpus <= 64))
    throw new Error("CLAUDEX_RUNNER_CPUS must be a number of cores above 0.");
  const cgroup = (env.CLAUDEX_RUNNER_CGROUP ??
    "none") as RunnerConfig["cgroup"];
  if (cgroup !== "none" && cgroup !== "systemd-run")
    throw new Error("CLAUDEX_RUNNER_CGROUP must be none or systemd-run.");
  const modes = (env.CLAUDEX_RUNNER_MODES ?? "chat")
    .split(",")
    .map((mode) => mode.trim())
    .filter(Boolean) as Mode[];
  if (
    !modes.length ||
    modes.some((m) => !["chat", "cowork", "code"].includes(m))
  )
    throw new Error("CLAUDEX_RUNNER_MODES lists chat, cowork or code.");
  const labels: Record<string, string> = {};
  for (const pair of (env.CLAUDEX_RUNNER_LABELS ?? "").split(",")) {
    if (!pair.trim()) continue;
    const at = pair.indexOf("=");
    if (at < 1) throw new Error("CLAUDEX_RUNNER_LABELS is k=v,k=v.");
    labels[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  const codexBinary = env.CLAUDEX_RUNNER_CODEX || resolveRuntime();
  const stateDir = path.resolve(
    env.CLAUDEX_RUNNER_STATE_DIR || "/var/lib/claudex-runner",
  );
  const publicUrl = env.CLAUDEX_RUNNER_PUBLIC_URL?.replace(/\/+$/, "");
  if (publicUrl) new URL(publicUrl);
  // Sandboxes never reach the Claudex service directly (they use the gateway
  // bridge); bwrap isolation caps the level at trusted.
  const network = parseNetConfig(
    env,
    driver === "runsc" ? "gvisor" : "namespaces",
    [serviceUrl, publicUrl]
      .filter((value): value is string => !!value)
      .map((value) => new URL(value).hostname),
  );
  return {
    serviceUrl,
    ...(publicUrl ? { publicUrl } : {}),
    token,
    stateDir,
    driver,
    cgroup,
    ...(driver === "runsc"
      ? {
          runsc: {
            rootfs: path.resolve(
              env.CLAUDEX_RUNNER_IMAGE ||
                path.join(stateDir, "images/current/rootfs"),
            ),
            runsc: env.CLAUDEX_RUNNER_RUNSC || "runsc",
            platform: env.CLAUDEX_RUNNER_RUNSC_PLATFORM || "systrap",
            sudo: env.CLAUDEX_RUNNER_SUDO === "1",
          },
        }
      : {}),
    cpus,
    pids: positive(env.CLAUDEX_RUNNER_PIDS, "CLAUDEX_RUNNER_PIDS", 512),
    diskMb: positive(
      env.CLAUDEX_RUNNER_DISK_MB,
      "CLAUDEX_RUNNER_DISK_MB",
      5120,
    ),
    diskQuota,
    codexBinary,
    codexRoot:
      env.CLAUDEX_RUNNER_CODEX_ROOT || path.dirname(path.dirname(codexBinary)),
    pathDirs: (env.CLAUDEX_RUNNER_PATH_DIRS ?? "").split(":").filter(Boolean),
    providerServiceScript:
      env.CLAUDEX_RUNNER_PROVIDER_SERVICE ||
      path.join(base, "provider-service.cjs"),
    wrapper:
      env.CLAUDEX_RUNNER_WRAPPER ||
      (fs.existsSync(path.join(base, "sandbox-codex.mjs"))
        ? path.join(base, "sandbox-codex.mjs")
        : undefined),
    ...(env.CLAUDEX_RUNNER_EGRESS_SOCKET
      ? { egressSocket: env.CLAUDEX_RUNNER_EGRESS_SOCKET }
      : {}),
    network: network.policy,
    networkWarnings: network.warnings,
    maxEngines: positive(
      env.CLAUDEX_RUNNER_MAX_ENGINES,
      "CLAUDEX_RUNNER_MAX_ENGINES",
      1,
    ),
    maxUsers: positive(
      env.CLAUDEX_RUNNER_MAX_USERS,
      "CLAUDEX_RUNNER_MAX_USERS",
      20,
    ),
    memoryMb: positive(
      env.CLAUDEX_RUNNER_MEMORY_MB,
      "CLAUDEX_RUNNER_MEMORY_MB",
      768,
    ),
    modes,
    labels,
  };
}

export const here = () => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
};

export function positive(
  value: string | undefined,
  name: string,
  fallback: number,
) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`${name} must be a whole number of at least 1.`);
  return number;
}
