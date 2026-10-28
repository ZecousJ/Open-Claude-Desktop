/**
 * Claudex's updater: asks the Claudex service for its release information at
 * launch and every four hours (and when Check for Updates… is chosen),
 * downloads a newer build in the background, verifies its SHA-256 and stages
 * it. Installing is apply.ts's job, when the person relaunches or quits. No
 * Electron imports: launch.ts wires it to the app.
 */
import fs from "node:fs";
import path from "node:path";
import type { AppUpdateStatus } from "../../shared/app-update-api";
import {
  planUpdate,
  updateKindFor,
  type InstalledApp,
  type LinuxPackage,
  type UpdatePlan,
  type UpdateRelease,
} from "../../shared/app-update";
import { compareVersions } from "../../shared/client-policy-rules";
import { validClaudexVersion } from "../../shared/claudex-contract";
import {
  updaterIntervals,
  type DesktopUpdaterConfig,
} from "../../shared/update-policy";
import { ChecksumMismatch, downloadVerified, fileSha256 } from "./download";
import {
  clearFailed,
  clearStaged,
  failedVersions,
  pruneUpdates,
  readStaged,
  updatesDir,
  writeStaged,
  type StagedUpdate,
} from "./staging";

/** . */
export const checkIntervalMs = 4 * 60 * 60 * 1000;
/** After launch, so the first check does not compete with start-up. */
export const firstCheckDelayMs = 90_000;
/** While an update is staged, the feed is peeked for a newer release. */
export const stagedPeekIntervalMs = 120 * 60 * 1000;

export interface UpdaterOptions {
  userData: string;
  currentVersion: string;
  platform: string;
  arch: string;
  /** How this Linux install was made (deb, rpm or the /opt/claudex tarball); undefined elsewhere or unknown. */
  linuxPackage?: LinuxPackage;
  /** Only packaged builds update themselves. */
  packaged: boolean;
  disableAutoUpdates?: boolean;
  maxVersion?: string;
  /** GET /api/v1/claudex/release for this build. */
  fetchRelease: () => Promise<UpdateRelease>;
  /** Windows: this install, read only when a release offers an app pack. */
  installed?: () => Promise<InstalledApp | undefined>;
  /** Lightweight release-version peek used while an update is staged. */
  peekRelease?: () => Promise<UpdateRelease>;
  download?: typeof downloadVerified;
  onStatus?: (status: AppUpdateStatus) => void;
  onDownloaded?: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => { cancel(): void };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const networkFailure = (error: unknown) =>
  /ERR_(EMPTY_RESPONSE|CONNECTION_(REFUSED|RESET)|CERT_|TUNNEL_CONNECTION_FAILED|BLOCKED_BY_)/i.test(
    message(error),
  );

export function updateCheckError(error: unknown) {
  const detail = message(error);
  if (networkFailure(error))
    return `Claudex couldn't reach the update server. If you're on a work network, a firewall or proxy may be blocking it — ask your IT team to allow it. Otherwise, check your connection and try again, or download the latest version from your Claudex service's website.`;
  return `Failed to check for updates: ${detail}`;
}

export interface CheckResult {
  status: AppUpdateStatus;
  plan?: UpdatePlan;
}

export class AppUpdater {
  private current: AppUpdateStatus;
  private running: Promise<CheckResult> | undefined;
  private timer: { cancel(): void } | undefined;
  private stopped = false;
  private lastProgressEmit = 0;
  private config?: DesktopUpdaterConfig;
  private started = false;
  readonly dir: string;

  constructor(private readonly options: UpdaterOptions) {
    this.dir = updatesDir(options.userData);
    this.current = {
      phase: "idle",
      supported: this.supported(),
      currentVersion: options.currentVersion,
    };
    const staged = this.staged();
    if (this.current.supported && staged)
      this.current = {
        ...this.current,
        phase: "ready",
        version: staged.version,
      };
  }

  /** . */
  menuVisible() {
    const { options } = this;
    return (
      options.packaged &&
      !!updateKindFor(options.platform, options.arch, options.linuxPackage) &&
      !options.disableAutoUpdates &&
      process.env.CLAUDEX_DISABLE_UPDATES !== "1"
    );
  }

  /** A packaged installation for which the platform has an update kind. */
  supported() {
    return this.menuVisible();
  }

  status(): AppUpdateStatus {
    const status = { ...this.current, supported: this.supported() };
    // A staged update that was already tried and is still here did not install.
    if (status.phase === "ready" && (this.staged()?.attempts ?? 0) > 0)
      status.retry = true;
    return status;
  }

  /** The staged update newer than this build, if any. */
  staged(): StagedUpdate | undefined {
    const staged = readStaged(this.dir);
    return staged &&
      (!this.options.maxVersion ||
        compareVersions(staged.version, this.options.maxVersion) <= 0) &&
      compareVersions(staged.version, this.options.currentVersion) > 0 &&
      fs.existsSync(staged.file)
      ? staged
      : undefined;
  }

  private set(next: Omit<AppUpdateStatus, "supported" | "currentVersion">) {
    const wasReady = this.current.phase === "ready";
    const { manual: _manual, ...rest } = next as AppUpdateStatus;
    this.current = {
      ...rest,
      ...(this.manualRun &&
      (next.phase === "checking" || next.phase === "downloading")
        ? { manual: true }
        : {}),
      supported: this.supported(),
      currentVersion: this.options.currentVersion,
    };
    this.options.onStatus?.(this.status());
    if (this.started && wasReady !== (next.phase === "ready"))
      this.schedule(this.interval());
  }

  /** Checks at launch (after a short delay) and then every four hours. */
  start() {
    if (!this.supported()) return;
    this.stopped = false;
    this.started = true;
    this.schedule(firstCheckDelayMs);
  }

  stop() {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
  }

  private schedule(ms: number) {
    this.timer?.cancel();
    if (this.stopped) return;
    const setTimer =
      this.options.setTimer ??
      ((callback: () => void, delay: number) => {
        const handle = setTimeout(callback, delay);
        handle.unref?.();
        return { cancel: () => clearTimeout(handle) };
      });
    this.timer = setTimer(() => {
      void this.check().finally(() => this.schedule(this.interval()));
    }, ms);
  }

  private interval() {
    const intervals = updaterIntervals(this.config);
    return this.staged() && this.options.peekRelease
      ? intervals.peek
      : intervals.check;
  }

  /**
   * One check: release information, then download and stage a newer build.
   * A check already running is joined. `manual` (Check for Updates…) also
   * retries a version whose install failed before.
   */
  check(options: { manual?: boolean } = {}): Promise<CheckResult> {
    // Check for Updates… joining a running check makes it a manual one: the
    // sidebar then says what it is doing.
    if (!this.supported()) return Promise.resolve({ status: this.status() });
    if (options.manual && !this.manualRun) {
      this.manualRun = true;
      if (this.running) this.set({ ...this.current });
    }
    if (!this.running)
      this.running = this.run(options.manual ?? false).finally(() => {
        this.running = undefined;
        this.manualRun = false;
      });
    return this.running;
  }
  /** The running check was asked for (Check for Updates…). */
  private manualRun = false;

  private async run(manual: boolean): Promise<CheckResult> {
    if (!this.supported()) {
      this.set({ phase: "idle" });
      return { status: this.status() };
    }
    const staged = this.staged();
    let peeked: UpdateRelease | undefined;
    if (staged && !manual && this.options.peekRelease) {
      try {
        peeked = await this.options.peekRelease();
        this.config = peeked.desktopUpdaterConfig;
        const latest = peeked.latestVersion;
        if (!validClaudexVersion(latest)) {
          this.set({ phase: "ready", version: staged.version });
          return { status: this.status() };
        }
        if (latest && compareVersions(latest, staged.version) < 0)
          clearStaged(this.dir);
        else if (!latest || compareVersions(latest, staged.version) === 0) {
          this.set({ phase: "ready", version: staged.version });
          return { status: this.status() };
        }
      } catch {
        this.set({ phase: "ready", version: staged.version });
        return { status: this.status() };
      }
    }
    if (!staged || manual) this.set({ phase: "checking" });
    let release: UpdateRelease;
    try {
      release = peeked ?? (await this.options.fetchRelease());
      this.config = release.desktopUpdaterConfig;
    } catch (error) {
      if (staged) {
        this.set({ phase: "ready", version: staged.version });
        return { status: this.status() };
      }
      this.set({
        phase: "error",
        error: updateCheckError(error),
      });
      return { status: this.status() };
    }
    const checkedAt = (this.options.now ?? Date.now)();
    if (
      this.options.maxVersion &&
      release.latestVersion &&
      compareVersions(release.latestVersion, this.options.maxVersion) > 0
    ) {
      clearStaged(this.dir);
      this.set({ phase: "up-to-date", checkedAt });
      return { status: this.status() };
    }
    const plan = planUpdate(
      release,
      this.options.currentVersion,
      this.options.platform,
      this.options.arch,
      this.options.linuxPackage,
      release.appPack
        ? await this.options.installed?.().catch(() => undefined)
        : undefined,
    );
    // A staged build the service no longer offers (it went back to an
    // older version) is not installed.
    if (
      staged &&
      (plan.action === "download"
        ? plan.version !== staged.version
        : plan.version !== undefined &&
          compareVersions(plan.version, staged.version) < 0)
    ) {
      clearStaged(this.dir);
    }
    if (plan.action === "none") {
      const still = this.staged();
      if (still)
        this.set({ phase: "ready", version: still.version, checkedAt });
      else if (
        plan.reason === "current" ||
        plan.reason === "downgrade" ||
        plan.reason === "no-release"
      )
        this.set({ phase: "up-to-date", checkedAt });
      else
        this.set({
          phase: "error",
          checkedAt,
          ...(plan.version ? { version: plan.version } : {}),
          error:
            plan.reason === "no-checksum"
              ? `Claudex ${plan.version} was published without a checksum, so it can't be verified.`
              : `Claudex ${plan.version} has no installer for this computer.`,
        });
      return { status: this.status(), plan };
    }
    const ready = this.staged();
    if (ready && ready.version === plan.version) {
      this.set({ phase: "ready", version: ready.version, checkedAt });
      return { status: this.status(), plan };
    }
    if (failedVersions(this.dir).includes(plan.version)) {
      if (!manual) {
        this.set({
          phase: "error",
          version: plan.version,
          checkedAt,
          error: `Claudex ${plan.version} couldn't be installed.`,
        });
        return { status: this.status(), plan };
      }
      clearFailed(this.dir);
    }
    return this.fetch(plan, checkedAt);
  }

  private async fetch(
    plan: Extract<UpdatePlan, { action: "download" }>,
    checkedAt: number,
  ): Promise<CheckResult> {
    const file = path.join(this.dir, plan.fileName);
    pruneUpdates(this.dir, [file]);
    this.set({ phase: "downloading", version: plan.version, checkedAt });
    const now = this.options.now ?? Date.now;
    try {
      await (this.options.download ?? downloadVerified)({
        url: plan.url,
        file,
        sha256: plan.sha256,
        onProgress: (received, total) => {
          if (!total) return;
          const time = now();
          if (time - this.lastProgressEmit < 250 && received < total) return;
          this.lastProgressEmit = time;
          this.set({
            phase: "downloading",
            version: plan.version,
            checkedAt,
            progress: Math.min(1, received / total),
          });
        },
      });
      // Checked again after the download: the file on disk is what is staged.
      if ((await fileSha256(file)) !== plan.sha256)
        throw new ChecksumMismatch();
      writeStaged(this.dir, {
        version: plan.version,
        kind: plan.kind,
        file,
        sha256: plan.sha256,
        stagedAt: now(),
        attempts: 0,
      });
      this.set({ phase: "ready", version: plan.version, checkedAt });
      this.options.onDownloaded?.();
    } catch (error) {
      if (error instanceof ChecksumMismatch) fs.rmSync(file, { force: true });
      this.set({
        phase: "error",
        version: plan.version,
        checkedAt,
        error: message(error),
      });
    }
    return { status: this.status(), plan };
  }
}
