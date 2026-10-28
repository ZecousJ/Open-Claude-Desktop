import fs from "node:fs";
import path from "node:path";
import type { AppUpdateStatus } from "../../shared/app-update-api";
import { compareVersions } from "../../shared/client-policy-rules";
import { validClaudexVersion } from "../../shared/claudex-contract";
import {
  updateDeviceQuery,
  type UpdateDevice,
} from "../../shared/update-policy";
import { firstCheckDelayMs, updateCheckError } from "./updater";
import {
  updaterIntervals,
  type DesktopUpdaterConfig,
} from "../../shared/update-policy";

export interface NativeUpdateDriver {
  on(event: string, listener: (...args: any[]) => void): unknown;
  setFeedURL(options: { url: string; serverType: "json" }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
}

export function squirrelFeedUrl(base: string, device: UpdateDevice) {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("The update feed must use HTTPS without credentials.");
  for (const [key, value] of updateDeviceQuery(device))
    url.searchParams.set(key, value);
  return url.href;
}

export function squirrelWindowsExecutable(execPath: string) {
  return path.win32.resolve(path.win32.dirname(execPath), "..", "Update.exe");
}

// .
export class NativeAppUpdater {
  private current: AppUpdateStatus;
  private pending?: { version: string; stagedAt: number; attempts: number };
  private running?: Promise<{ status: AppUpdateStatus }>;
  private resolve?: (result: { status: AppUpdateStatus }) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private checkTimeout?: ReturnType<typeof setTimeout>;
  private manual = false;
  private attempts = 0;
  private attemptedVersion?: string;
  private stopped = false;
  private started = false;

  constructor(
    private readonly options: {
      driver: NativeUpdateDriver;
      feedUrl: string;
      selectFeed?: () => Promise<string>;
      clearFeedProbe?: () => void;
      currentVersion: string;
      userData: string;
      onStatus: (status: AppUpdateStatus) => void;
      log: (message: string, error?: unknown) => void;
      peekVersion?: () => Promise<string | null>;
      unstage?: () => void;
      disableAutoUpdates?: boolean;
      updaterConfig?: () => DesktopUpdaterConfig | undefined;
      onDownloaded?: () => void;
    },
  ) {
    this.current = {
      phase: "idle",
      currentVersion: options.currentVersion,
      supported: this.supported(),
    };
    try {
      const record = JSON.parse(fs.readFileSync(this.recordFile(), "utf8"));
      if (
        record.from === options.currentVersion &&
        typeof record.version === "string"
      ) {
        this.attemptedVersion = record.version;
        this.attempts = Number.isInteger(record.attempts)
          ? Math.max(0, record.attempts)
          : 0;
      } else fs.rmSync(this.recordFile(), { force: true });
    } catch {
      /* No previous native install attempt. */
    }
    const driver = options.driver;
    driver.on("checking-for-update", () => this.set("checking"));
    driver.on("update-available", () => this.set("downloading"));
    driver.on("update-not-available", () =>
      this.finish(this.pending ? "ready" : "up-to-date"),
    );
    driver.on("error", (error: Error) => {
      options.clearFeedProbe?.();
      options.log("native auto-update error", error);
      this.finish(this.pending ? "ready" : "error", updateCheckError(error));
    });
    driver.on("update-downloaded", (_event, _notes, releaseName: string) => {
      const version = releaseName?.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0];
      if (!version || compareVersions(version, options.currentVersion) <= 0) {
        this.finish(
          "error",
          "The update feed returned an invalid release version.",
        );
        return;
      }
      this.pending = {
        version,
        stagedAt: Date.now(),
        attempts: version === this.attemptedVersion ? this.attempts : 0,
      };
      this.finish("ready");
      options.onDownloaded?.();
    });
  }

  private recordFile() {
    return path.join(this.options.userData, "native-update-attempt.json");
  }
  menuVisible() {
    return (
      !this.options.disableAutoUpdates &&
      process.env.CLAUDEX_DISABLE_UPDATES !== "1"
    );
  }
  supported() {
    return this.menuVisible();
  }
  status(): AppUpdateStatus {
    return {
      ...this.current,
      supported: this.supported(),
      ...(this.pending && this.pending.attempts > 0 ? { retry: true } : {}),
    };
  }
  staged() {
    return this.pending;
  }

  private set(phase: AppUpdateStatus["phase"], error?: string) {
    const wasReady = this.current.phase === "ready";
    this.current = {
      phase,
      currentVersion: this.options.currentVersion,
      supported: this.supported(),
      ...(this.pending ? { version: this.pending.version } : {}),
      ...(this.manual && (phase === "checking" || phase === "downloading")
        ? { manual: true }
        : {}),
      ...(error ? { error } : {}),
      ...(phase === "ready" || phase === "up-to-date" || phase === "error"
        ? { checkedAt: Date.now() }
        : {}),
    };
    this.options.onStatus(this.status());
    if (this.started && wasReady !== (phase === "ready"))
      this.schedule(this.interval());
  }

  private finish(phase: AppUpdateStatus["phase"], error?: string) {
    clearTimeout(this.checkTimeout);
    this.set(phase, error);
    const resolve = this.resolve;
    this.resolve = undefined;
    this.running = undefined;
    this.manual = false;
    resolve?.({ status: this.status() });
  }

  check(options: { manual?: boolean } = {}) {
    if (!this.supported()) return Promise.resolve({ status: this.status() });
    if (options.manual) this.manual = true;
    if (this.running) {
      this.set(this.current.phase);
      return this.running;
    }
    const running = new Promise<{ status: AppUpdateStatus }>((resolve) => {
      this.resolve = resolve;
    });
    this.running = running;
    const begin = async () => {
      try {
        const url = this.options.selectFeed
          ? await this.options.selectFeed()
          : this.options.feedUrl;
        if (this.stopped) return;
        this.options.driver.setFeedURL({
          url,
          serverType: "json",
        });
        this.checkTimeout = setTimeout(
          () =>
            this.finish(
              this.pending ? "ready" : "error",
              updateCheckError(new Error("Update check timed out.")),
            ),
          30 * 60_000,
        );
        this.checkTimeout.unref();
        this.options.driver.checkForUpdates();
      } catch (error) {
        this.options.clearFeedProbe?.();
        this.finish(this.pending ? "ready" : "error", updateCheckError(error));
      }
    };
    if (this.pending && this.options.peekVersion) {
      void this.options
        .peekVersion()
        .then((version) => {
          if (!validClaudexVersion(version)) {
            this.finish("ready");
            return;
          }
          if (
            this.pending &&
            compareVersions(version, this.pending.version) === 0
          ) {
            this.finish("ready");
            return;
          }
          if (
            this.pending &&
            compareVersions(version, this.pending.version) < 0
          ) {
            if (!this.options.unstage) {
              this.finish("ready");
              return;
            }
            this.options.unstage();
            this.pending = undefined;
          }
          if (!this.stopped) begin();
        })
        .catch((error) => {
          this.options.log("native staged version check failed", error);
          this.finish("ready");
        });
    } else if (this.options.peekVersion) {
      void this.options
        .peekVersion()
        .catch(() => null)
        .then(() => {
          if (!this.stopped) begin();
        });
    } else begin();
    return running;
  }

  start() {
    if (!this.supported()) return;
    this.stopped = false;
    this.started = true;
    this.schedule(firstCheckDelayMs);
  }

  private interval() {
    const intervals = updaterIntervals(this.options.updaterConfig?.());
    return this.pending ? intervals.peek : intervals.check;
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.check().finally(() => {
        this.schedule(this.interval());
      });
    }, ms);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.checkTimeout);
  }

  recordInstallAttempt() {
    if (!this.pending) throw new Error("No update is ready to install.");
    fs.mkdirSync(this.options.userData, { recursive: true });
    fs.writeFileSync(
      this.recordFile(),
      JSON.stringify({
        from: this.options.currentVersion,
        version: this.pending.version,
        attempts: this.pending.attempts + 1,
      }),
      { mode: 0o600 },
    );
  }

  quitAndInstall() {
    this.recordInstallAttempt();
    this.options.driver.quitAndInstall();
  }
}
