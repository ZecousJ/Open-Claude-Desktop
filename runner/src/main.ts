/**
 * claudex-runner: runs web users' conversations for the Claudex service (web
 * plan §0, §1). Built by scripts/build-runner.mjs into dist-runner/runner.mjs
 * (Node 22+, "electron" mapped to runner/src/electron-shim.ts).
 *
 * Configuration (environment; the systemd unit reads an EnvironmentFile):
 *   CLAUDEX_RUNNER_SERVICE_URL   the Claudex service for the link, user APIs
 *                                and the /v1 gateway (e.g. http://127.0.0.1:8080)
 *   CLAUDEX_RUNNER_PUBLIC_URL    the address browsers use, when it differs
 *                                (pages to open are made relative to it)
 *   CLAUDEX_RUNNER_TOKEN_FILE    file holding the runner token (0600), or
 *   CLAUDEX_RUNNER_TOKEN         the token itself (removed from the
 *                                environment at start, so no child sees it)
 *   CLAUDEX_RUNNER_STATE_DIR     per-user data and sandboxes (default
 *                                /var/lib/claudex-runner)
 *   CLAUDEX_RUNNER_DRIVER        bwrap (default) | runsc (gVisor) | none
 *                                (development only: codex runs unsandboxed)
 *   CLAUDEX_RUNNER_IMAGE         runsc: the unpacked sandbox image (default
 *                                <state dir>/images/current/rootfs)
 *   CLAUDEX_RUNNER_RUNSC         runsc: the runsc program (default runsc)
 *   CLAUDEX_RUNNER_RUNSC_PLATFORM runsc: gVisor platform (default systrap)
 *   CLAUDEX_RUNNER_SUDO          1: runsc and the disk quota tools through
 *                                `sudo -n` (the runner stays unprivileged)
 *   CLAUDEX_RUNNER_CPUS          CPU cores of one user's sandbox (default 1)
 *   CLAUDEX_RUNNER_PIDS          processes of one user's sandbox (default 512)
 *   CLAUDEX_RUNNER_DISK_MB       disk space of one user's data (default 5120)
 *   CLAUDEX_RUNNER_DISK_QUOTA    none (default) | loop (an ext4 volume per
 *                                user) | xfs-project | soft (measure only)
 *   CLAUDEX_RUNNER_CGROUP        none (default) | systemd-run (enforce limits)
 *   CLAUDEX_RUNNER_CODEX         the codex executable (default: the
 *                                @openai/codex package next to the runner)
 *   CLAUDEX_RUNNER_CODEX_ROOT    directory mounted read-only for codex
 *   CLAUDEX_RUNNER_PATH_DIRS     extra read-only PATH directories (colon list)
 *   CLAUDEX_RUNNER_PROVIDER_SERVICE  provider-service.cjs (default: next to
 *                                this bundle)
 *   CLAUDEX_RUNNER_WRAPPER       the sandbox launcher program (default:
 *                                sandbox-codex.mjs next to this bundle)
 *   CLAUDEX_RUNNER_EGRESS_SOCKET an external egress proxy's Unix socket;
 *                                the runner applies the policy below before
 *                                forwarding through it (or serves its own
 *                                proxy when unset), one socket per sandbox
 *   CLAUDEX_RUNNER_NETWORK       none | trusted (default) | custom | full;
 *                                bwrap caps it at trusted (net-policy.ts
 *                                lists the other CLAUDEX_RUNNER_EGRESS_* and
 *                                *_DOMAINS settings)
 *   CLAUDEX_RUNNER_MAX_ENGINES   running engines at once (default 1)
 *   CLAUDEX_RUNNER_MAX_USERS     user contexts at once (default 20)
 *   CLAUDEX_RUNNER_MEMORY_MB     memory limit of one sandbox (default 768)
 *   CLAUDEX_RUNNER_MODES         conversation modes offered (default chat)
 *   CLAUDEX_RUNNER_LABELS        k=v,k=v labels for the service's Runners page
 */
import { RoutineWakes } from "./routine-wakes";
import { connectorUrlGuard } from "./connectors";
import fs from "node:fs";
import { cachePressure } from "../../electron/engine/codex-cache";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { version as packageVersion } from "../../package.json";
import { webHost, type HostInfo } from "../../shared/host";
import type { PrepareWorkspace } from "./code-workspace";
import { protectCoworkFolders } from "../../electron/workspace/cowork-folders-support";
import { chatSandboxSpec } from "./sandbox/sandbox-setup";
import { sandboxWorkingTree } from "./sandbox-git";
import { captureSandboxArtifact } from "./artifact-screenshot";
import { userNetworkPolicy, type UserNetwork } from "./net-policy-compile";
import { EgressProxy } from "./egress-proxy";
import { egressSocketPath } from "./egress-support";
import type { CloudEnvironmentConfig } from "../../shared/cloud-environments-api";
import { parseEnvFile } from "../../shared/env-file";
import { BwrapDriver } from "./sandbox/bwrap";
import { RunscDriver } from "./sandbox/runsc";
import { createDiskQuota, type DiskQuota } from "./sandbox/quota";
import { prepareUserVolume } from "./user-volume";
import { ControlLink } from "./control-link";
import { Dispatcher } from "./dispatcher";
import { EventHub } from "./event-hub";
import { setShimVersion } from "./electron-shim";
import { keepConnectionsOpen } from "../../electron/app/keep-alive";
import { type RunnerConfig, parseConfig } from "./runner-config";
import { here } from "./runner-config";

/**
 * A page address as the user's tab should open it: pages of the service
 * itself become same-origin paths (the runner may reach the service at an
 * internal address the browser cannot use).
 */
export function pageForBrowser(
  url: string,
  config: Pick<RunnerConfig, "serviceUrl" | "publicUrl">,
) {
  const parsed = new URL(url);
  const own = [config.serviceUrl, config.publicUrl]
    .filter((value): value is string => !!value)
    .map((value) => new URL(value).origin);
  if (own.includes(parsed.origin))
    return parsed.pathname + parsed.search + parsed.hash;
  return parsed.href;
}

/**
 * The host the web app is told about (Snapshot.host): cloud Cowork and Code
 * where this runner runs them, the environment (the runner's one, "Default",
 * with its sandbox network level) and the permission modes the sandbox
 * supports. The sandbox remains the boundary even in bypass mode.
 */
export function runnerHost(
  config: Pick<RunnerConfig, "modes" | "network">,
): HostInfo {
  const code = config.modes.includes("code");
  const cowork = config.modes.includes("cowork");
  return {
    ...webHost,
    sandboxNetwork: config.network.level,
    capabilities: {
      ...webHost.capabilities,
      cloudCowork: cowork,
      cloudCode: code,
      codeSessionPermissions: code,
      scheduledTasks: code || cowork,
      customConnectors: true,
    },
    ...(code || cowork
      ? {
          cloud: {
            environments: [
              {
                id: "default",
                name: "Default",
                network: config.network.level,
                isDefault: true,
              },
            ],
            permissionModes: [
              "auto",
              "manual",
              "acceptEdits",
              "plan",
              "bypass",
            ],
          },
        }
      : {}),
  } as HostInfo;
}

/** What a caller can add around the runner (the GitHub package's hook). */
export interface RunnerHooks {
  /** Prepares a new Code session's folder; the default is an empty folder. */
  prepareWorkspace?: PrepareWorkspace;
}

/** Wires the link, the event hub and the dispatcher; returns a stop function. */
export async function startRunner(
  config: RunnerConfig,
  log = console.error,
  hooks: RunnerHooks = {},
) {
  setShimVersion(packageVersion);
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  // Nothing of the runner's own state may become a Cowork folder.
  protectCoworkFolders(config.stateDir);
  const driver =
    config.driver === "runsc" && config.runsc
      ? new RunscDriver({
          rootfs: config.runsc.rootfs,
          runsc: config.runsc.runsc,
          platform: config.runsc.platform,
          sudo: config.runsc.sudo,
          wrapper:
            config.runscWrapper ?? path.join(here(), "sandbox-runsc.mjs"),
        })
      : config.driver === "bwrap"
        ? new BwrapDriver({
            cgroup: config.cgroup,
            ...(config.wrapper ? { wrapper: config.wrapper } : {}),
          })
        : undefined;
  // Each user's data is a volume of at most diskMb (quota.ts): mounted
  // before their context writes anything, and grown when the limit goes up.
  const quota: DiskQuota | undefined =
    config.diskQuota === "none"
      ? undefined
      : createDiskQuota(config.diskQuota, {
          imagesDir: path.join(config.stateDir, "volumes"),
          sudo: config.runsc?.sudo ?? false,
          owner: {
            uid: process.getuid?.() ?? 0,
            gid: process.getgid?.() ?? 0,
          },
        });
  if (quota)
    log(
      `claudex-runner: each user's data is limited to ${config.diskMb} MiB (${quota.mode})`,
    );
  if (driver) {
    const check = await driver.check();
    for (const warning of check.warnings) log(`claudex-runner: ${warning}`);
    if (!check.ok)
      throw new Error(
        `The sandbox cannot run on this host: ${check.problems.join("; ")}`,
      );
  } else
    log(
      "claudex-runner: WARNING: CLAUDEX_RUNNER_DRIVER=none runs codex without a sandbox. Use it for development only.",
    );
  const sandboxRoot = path.join(config.stateDir, "sandboxes");
  // One egress listener per sandbox; an external proxy remains an upstream
  // so user and environment restrictions still apply before forwarding.
  const egress = driver
    ? new EgressProxy({ log, upstreamSocket: config.egressSocket })
    : undefined;
  if (egress) {
    for (const warning of config.networkWarnings)
      log(`claudex-runner: ${warning}`);
    log(`claudex-runner: sandbox network level ${config.network.level}`);
  }
  // Each user's sandbox network: the runner's policy narrowed by what they
  // chose in Settings → Capabilities (net-policy.ts `userNetworkPolicy`).
  const userNetworks = new Map<number, UserNetwork>();
  const environmentNetworks = new Map<string, CloudEnvironmentConfig>();
  const networkFor = (userId: number, sandboxId?: string) => {
    const user = userNetworks.get(userId);
    const policy = user
      ? userNetworkPolicy(config.network, user)
      : config.network;
    const profile = sandboxId && environmentNetworks.get(sandboxId);
    return profile
      ? {
          ...policy,
          restriction: {
            level: profile.network,
            trustedDomains:
              profile.network === "custom" && !profile.includeDefaultDomains
                ? []
                : policy.trustedDomains,
            customDomains: profile.allowedDomains,
          },
        }
      : policy;
  };
  let link: ControlLink;
  const hub = new EventHub({
    sink: { send: (frame) => link.send(frame) },
    log,
  });
  // Scheduled tasks that come due while nobody has a page open.
  let wakeUser: (userId: number) => Promise<void> = async () => {};
  const wakes = new RoutineWakes({
    stateDir: config.stateDir,
    wake: (userId) => wakeUser(userId),
    log,
  });
  // Each user's sandbox network listeners (the shared one and one per space).
  const egressIds = new Map<number, Set<string>>();
  const sandboxesOf = (userId: number) => [
    ...(egressIds.get(userId) ?? [`chat-${userId}`]),
  ];
  const dispatcher = new Dispatcher({
    runtime: {
      wake: (userId, at) => wakes.set(userId, at),
      connectorGuard: connectorUrlGuard(config.network),
      network: (userId, user) => {
        userNetworks.set(userId, user);
        for (const id of sandboxesOf(userId))
          egress?.get(id)?.update(networkFor(userId, id));
      },
      releaseSandbox: (userId, sandboxId) => {
        environmentNetworks.delete(sandboxId);
        egressIds.get(userId)?.delete(sandboxId);
        void egress?.close(sandboxId);
      },
      serviceUrl: config.serviceUrl,
      stateDir: config.stateDir,
      cachePressure: (profile) => {
        const status = quota?.status(profile, config.diskMb);
        if (status && cachePressure(status.usedBytes, status.limitBytes))
          return true;
        const disk = fs.statfsSync(profile);
        return (
          cachePressure(disk.blocks - disk.bavail, disk.blocks) ||
          cachePressure(disk.files - disk.ffree, disk.files)
        );
      },
      ...(quota
        ? {
            prepareUserData: async (_userId: number, profile: string) => {
              const status = await prepareUserVolume(
                quota,
                profile,
                config.diskMb,
              );
              if (status.exceeded)
                log(
                  `claudex-runner: ${profile} is full (${config.diskMb} MiB)`,
                );
            },
          }
        : {}),
      providerServiceScript: config.providerServiceScript,
      version: packageVersion,
      captureArtifactScreenshot: (html) => {
        if (!driver)
          throw new Error("Artifact screenshots require the sandbox driver.");
        return captureSandboxArtifact(driver, sandboxRoot, html);
      },
      log,
      // The web app offers Cowork and Code only where this runner runs them.
      host: runnerHost(config),
      ...(hooks.prepareWorkspace
        ? { prepareWorkspace: hooks.prepareWorkspace }
        : {}),
      // The Changes panel's git runs in the user's sandbox, never here.
      ...(driver
        ? {
            workingTree: ({
              userId,
              storeRoot,
            }: {
              userId: number;
              storeRoot: string;
            }) =>
              sandboxWorkingTree({
                driver,
                userId,
                storeRoot,
                stateRoot: sandboxRoot,
              }),
          }
        : {}),
      sandboxNetwork: driver?.name === "runsc",
      codexBinary: ({
        userId,
        storeRoot,
        attachments,
        projects,
        sandboxId,
        cloudEnvironment,
        codexCache,
      }) => {
        if (!driver) return config.codexBinary;
        // One sandbox per isolated space (docs/cloud-sync.md), each with its
        // own egress socket; the user's shared one otherwise.
        const id = sandboxId ?? `chat-${userId}`;
        if (cloudEnvironment) environmentNetworks.set(id, cloudEnvironment);
        if (egress) {
          const ids = egressIds.get(userId) ?? new Set<string>();
          ids.add(id);
          egressIds.set(userId, ids);
        }
        const egressSocket = egress
          ? egress.open(id, networkFor(userId, id), {
              socket: egressSocketPath(config.stateDir, id),
            }).socket
          : config.egressSocket;
        return driver.prepare(
          chatSandboxSpec({
            env: parseEnvFile(cloudEnvironment?.variables ?? ""),
            userId,
            id,
            storeRoot,
            stateRoot: sandboxRoot,
            codexCache,
            codexBinary: config.codexBinary,
            codexRoot: config.codexRoot,
            pathDirs: config.pathDirs,
            egressSocket,
            readOnly: [attachments, projects],
            limits: {
              memoryMb: config.memoryMb,
              pids: config.pids,
              cpus: config.cpus,
              diskMb: config.diskMb,
            },
          }),
        ).binary;
      },
    },
    link: {
      send: (frame) => link.send(frame),
      request: (op, userId, body) => link.request(op, userId, body),
    },
    publish: (userId, event) => hub.publish(userId, event),
    openUrl: (userId, url, tabId) =>
      hub.openUrl(userId, pageForBrowser(url, config), "same-tab", tabId),
    forget: (userId) => {
      hub.forget(userId);
      // The user's sandboxes are gone with the context: so are their listeners.
      for (const id of sandboxesOf(userId)) void egress?.close(id);
      egressIds.delete(userId);
    },
    flush: (userId) => hub.flush(userId),
    maxEngines: config.maxEngines,
    maxUsers: config.maxUsers,
    guard: { modes: config.modes },
    log,
  });
  link = new ControlLink({
    serviceUrl: config.serviceUrl,
    token: config.token,
    version: packageVersion,
    methods: () => dispatcher.methods,
    capacity: () => ({ engines: config.maxEngines, users: config.maxUsers }),
    labels: config.labels,
    load: () => dispatcher.load(),
    log,
    handlers: {
      welcome: (frame) => {
        log(`claudex-runner: linked as ${frame.runnerId}`);
        // The link is up: the users whose tasks are due can be woken now.
        wakes.scan();
      },
      call: (frame) => void dispatcher.call(frame),
      cancel: (id) => dispatcher.cancel(id),
      presence: (frame) => dispatcher.presence(frame),
      signedOut: (frame) => void dispatcher.signedOut(frame),
      drain: () => dispatcher.drain(),
      down: () => log("claudex-runner: the link dropped; dialling again"),
    },
  });
  wakeUser = (userId) => dispatcher.wakeUser(userId);
  dispatcher.start();
  link.start();
  return {
    dispatcher,
    wakes,
    link,
    hub,
    /**
     * Finishes running turns (at most `graceMs`, CLAUDEX_RUNNER_STOP_GRACE_MS
     * or twenty minutes) while serving every user, then closes everything:
     * an update waits for the last turn instead of cutting it.
     */
    async stop(graceMs = stopGraceMs()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        dispatcher.drain(
          () => {
            clearTimeout(timer);
            resolve();
          },
          { admitNew: true },
        );
      });
      wakes.stop();
      hub.flushAll();
      await dispatcher.stop();
      await egress?.closeAll();
      link.stop();
    },
  };
}

/** How long a stopping runner waits for running turns. */
function stopGraceMs() {
  const ms = Number(process.env.CLAUDEX_RUNNER_STOP_GRACE_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 20 * 60_000;
}

async function main() {
  keepConnectionsOpen();
  let config: RunnerConfig;
  try {
    config = parseConfig(process.env);
  } catch (error) {
    console.error(`claudex-runner: ${(error as Error).message}`);
    process.exit(2);
  }
  // No child (provider service, codex) ever sees the runner token.
  delete process.env.CLAUDEX_RUNNER_TOKEN;
  delete process.env.CLAUDEX_RUNNER_TOKEN_FILE;
  let runner: Awaited<ReturnType<typeof startRunner>>;
  try {
    runner = await startRunner(config);
  } catch (error) {
    console.error(`claudex-runner: ${(error as Error).message}`);
    process.exit(1);
  }
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`claudex-runner: ${signal}; finishing running turns`);
    void runner.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

/** This module is the program node was started with (not an import). */
function isEntry() {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    // Real paths: /var and /private/var are the same folder on macOS.
    return (
      fs.realpathSync(path.resolve(entry)) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
if (isEntry()) void main();
