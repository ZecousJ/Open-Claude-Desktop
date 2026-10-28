/**
 * Claudex's own updates: the main process checks the service's release
 * information, downloads and verifies the build in the background and stages
 * it; the sidebar then offers "Relaunch to update". The staged build is also
 * installed when the app quits.
 *
 * On the web these calls do not exist (shared/web-bridge-methods.ts); the
 * window then shows no update button.
 */
import { bridgeMethods } from "./bridge-methods";

export type AppUpdatePhase =
  /** Nothing to do yet, or updates are off (see `supported`). */
  | "idle"
  | "checking"
  | "downloading"
  /** Downloaded, verified and staged: relaunching installs it. */
  | "ready"
  | "up-to-date"
  | "error";

export interface AppUpdateStatus {
  phase: AppUpdatePhase;
  /**
   * This packaged installation can update itself, independently of sign-in.
   * Development builds and installations disabled by policy get no updates.
   */
  supported: boolean;
  currentVersion: string;
  /** The version being downloaded or staged. */
  version?: string;
  /** Download progress, 0–1, while downloading (absent when the size is unknown). */
  progress?: number;
  /** Why the last check or download failed (phase "error"). */
  error?: string;
  /** Epoch ms of the last completed check. */
  checkedAt?: number;
  /**
   * The check or download was asked for with Check for Updates… ("checking"
   * and "downloading" only): the sidebar says what it is doing.
   */
  manual?: boolean;
  /**
   * The staged update was already tried and did not install ("ready" only):
   * the sidebar offers "Relaunch to retry update".
   */
  retry?: boolean;
}

/** This app and its computer, for Session info's Desktop app row. */
export interface AppEnvironment {
  updateEndpoints?: {
    url: string;
    purpose: "Update feed" | "Update binaries";
  }[];
  version: string;
  /** "darwin", "win32", "linux". */
  platform: string;
  /** The system's version ("15.4.1", "10.0.26100"). */
  osVersion: string;
  arch: string;
  /** The home folder, which Session info writes as "~". */
  home: string;
}

export interface AppUpdateAPI {
  appUpdateStatus(): Promise<AppUpdateStatus>;
  /** This app's version and its computer's system (Session info). */
  appEnvironment(): Promise<AppEnvironment>;
  /** Checks now (the same pipeline as Check for Updates…). */
  checkForAppUpdate(): Promise<AppUpdateStatus>;
  /**
   * Quits, installs the staged update and opens the new version. The window
   * asks first when a task is running; with `interrupt` it has been told
   * and chose to update anyway, so the quit does not ask again.
   */
  relaunchToUpdate(options?: { interrupt?: boolean }): Promise<void>;
}

export const appUpdateMethods = bridgeMethods<AppUpdateAPI>({
  appUpdateStatus: true,
  appEnvironment: true,
  checkForAppUpdate: true,
  relaunchToUpdate: true,
});

/** Sent to every app window when the update status changes. */
export interface AppUpdateEvent {
  type: "app-update";
  status: AppUpdateStatus;
}
