/**
 * What Claudex's updater does with the service's release information. Pure:
 * the main process (electron/updates/) downloads, verifies and installs what
 * `planUpdate` names.
 */
import type { AppUpdateStatus } from "./app-update-api";
import { validClaudexVersion } from "./claudex-contract";
import { compareVersions } from "./client-policy-rules";
import type { DesktopUpdaterConfig } from "./update-policy";

/**
 * How a platform's build is installed: a zipped .app, the NSIS installer run
 * silently, or on Linux the package Claudex was installed from (deb, rpm, or
 * the tar.gz the install script puts in /opt/claudex), through the system's
 * authorization prompt.
 */
export type UpdateKind =
  | "mac-zip"
  | "win-nsis"
  /** Windows: the app files without the installer (ClaudexAppPack). */
  | "win-app"
  | "linux-deb"
  | "linux-rpm"
  | "linux-tar";

/** Linux package formats (the release's `?package=` and the download keys). */
export type LinuxPackage = "deb" | "rpm" | "tar";

/** macOS (arm64 and x64) replaces the .app from a zip; Windows runs the NSIS installer; Linux reinstalls its package. */
export function updateKindFor(
  platform: string,
  arch: string,
  linuxPackage?: LinuxPackage,
): UpdateKind | undefined {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64"))
    return "mac-zip";
  if (platform === "win32" && (arch === "x64" || arch === "arm64"))
    return "win-nsis";
  if (
    platform === "linux" &&
    (arch === "x64" || arch === "arm64") &&
    linuxPackage
  )
    return `linux-${linuxPackage}`;
  return undefined;
}

export type UpdateSkip =
  | "unsupported-platform"
  | "no-release"
  | "current"
  | "downgrade"
  | "no-download"
  | "no-checksum"
  | "wrong-file-type";

export type UpdatePlan =
  | {
      action: "download";
      version: string;
      url: string;
      /** Lower-case hex SHA-256 of the file. */
      sha256: string;
      kind: UpdateKind;
      /** The staged file's name in `<userData>/updates`. */
      fileName: string;
    }
  | { action: "none"; reason: UpdateSkip; version?: string };

/** The release fields the updater reads (bootstrap `release` / GET /claudex/release). */
export interface UpdateRelease {
  latestVersion: string | null;
  downloadUrl: string | null;
  sha256: string | null;
  desktopUpdaterConfig?: DesktopUpdaterConfig;
  appPack?: import("./claudex-contract").ClaudexAppPack | null;
}

/** This Windows install, as an app pack has to find it to apply. */
export interface InstalledApp {
  /** process.versions.electron */
  runtime: string;
  /** The SHA-256 of its Codex files (electron/updates/app-pack.ts), when readable. */
  keep?: string;
}

const extensionFor: Record<UpdateKind, string> = {
  "mac-zip": ".zip",
  "win-nsis": ".exe",
  "win-app": ".zip",
  "linux-deb": ".deb",
  "linux-rpm": ".rpm",
  "linux-tar": ".tar.gz",
};

/**
 * The download this build should stage, if any. Only a newer version is
 * installed (never a downgrade or the same version), only from an https
 * address, and only with a SHA-256 to check it against.
 */
export function planUpdate(
  release: UpdateRelease | null | undefined,
  currentVersion: string,
  platform: string,
  arch: string,
  linuxPackage?: LinuxPackage,
  installed?: InstalledApp,
): UpdatePlan {
  const kind = updateKindFor(platform, arch, linuxPackage);
  if (!kind) return { action: "none", reason: "unsupported-platform" };
  const version = release?.latestVersion;
  if (!release || !version || !validClaudexVersion(version))
    return { action: "none", reason: "no-release" };
  const order = compareVersions(version, currentVersion);
  if (order === 0) return { action: "none", reason: "current", version };
  if (order < 0) return { action: "none", reason: "downgrade", version };
  let url: URL;
  try {
    url = new URL(release.downloadUrl ?? "");
  } catch {
    return { action: "none", reason: "no-download", version };
  }
  if (url.protocol !== "https:" || url.username || url.password)
    return { action: "none", reason: "no-download", version };
  const sha256 = release.sha256?.toLowerCase();
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256))
    return { action: "none", reason: "no-checksum", version };
  if (
    !decodeURIComponent(url.pathname).toLowerCase().endsWith(extensionFor[kind])
  )
    return { action: "none", reason: "wrong-file-type", version };
  const safe = version.replace(/[^\w.-]/g, "_");
  // Windows: the app files alone when this install runs the same Electron
  // and has the same Codex files, so no new program is run to install them.
  const pack = release.appPack;
  if (
    kind === "win-nsis" &&
    pack &&
    installed?.keep &&
    pack.runtime === installed.runtime &&
    pack.keep === installed.keep
  ) {
    try {
      const packUrl = new URL(pack.url);
      if (
        packUrl.protocol === "https:" &&
        !packUrl.username &&
        !packUrl.password &&
        /^[0-9a-f]{64}$/.test(pack.sha256) &&
        decodeURIComponent(packUrl.pathname).toLowerCase().endsWith(".zip")
      )
        return {
          action: "download",
          version,
          url: packUrl.toString(),
          sha256: pack.sha256,
          kind: "win-app",
          fileName: `Claudex-${safe}-${arch}-app.zip`,
        };
    } catch {
      // The installer below.
    }
  }
  return {
    action: "download",
    version,
    url: url.toString(),
    sha256,
    kind,
    fileName:
      kind === "mac-zip"
        ? `Claudex-${safe}-${arch}-mac.zip`
        : kind === "win-nsis"
          ? `Claudex-Setup-${safe}.exe`
          : `Claudex-${safe}-linux-${arch}${extensionFor[kind]}`,
  };
}

/** Check for Updates… wording for a check that found nothing to install. */
export function updateSkipMessage(
  reason: UpdateSkip,
  currentVersion: string,
  version?: string,
) {
  switch (reason) {
    case "current":
    case "downgrade":
    case "no-release":
      return {
        title: "No Update Available",
        detail: "You are running the latest version.",
      };
    case "unsupported-platform":
      return {
        title: "Updates aren't available",
        detail: "Claudex can't update itself on this computer.",
      };
    case "no-checksum":
      return {
        title: "Update not installed",
        detail: `Claudex ${version} was published without a checksum, so it can't be verified. Ask your administrator to add one.`,
      };
    case "no-download":
    case "wrong-file-type":
      return {
        title: "Update not installed",
        detail: `Claudex ${version} has no installer for this computer. Ask your administrator for one.`,
      };
  }
}

/** The .app bundle an executable runs from (`…/X.app/Contents/MacOS/X`), if any. */
export function macAppBundle(execPath: string): string | undefined {
  const match = /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return match?.[1];
}

export type RelocationPlan =
  | { action: "none" }
  /** Rename this bundle to Claudex.app (nothing there yet). */
  | { action: "rename"; target: string }
  /** Replace an older Claudex.app with this bundle. */
  | { action: "replace"; target: string }
  /** Claudex.app is as new or newer: remove this copy and open that one. */
  | { action: "defer"; target: string };

/**
 * Where a Claudex bundle with another name moves: beside itself as
 * Claudex.app.
 * Bundles App Translocation or a disk image runs from stay where they are.
 */
export function relocationPlan(options: {
  bundle: string;
  version: string;
  /** Claudex.app's version beside the bundle; null when it has none, undefined when absent. */
  targetVersion: string | null | undefined;
}): RelocationPlan {
  const { bundle } = options;
  const slash = bundle.lastIndexOf("/");
  if (slash <= 0) return { action: "none" };
  const folder = bundle.slice(0, slash);
  const name = bundle.slice(slash + 1);
  if (name === "Claudex.app") return { action: "none" };
  if (/\/AppTranslocation\//.test(bundle) || bundle.startsWith("/Volumes/"))
    return { action: "none" };
  const target = `${folder}/Claudex.app`;
  if (options.targetVersion === undefined) return { action: "rename", target };
  if (
    options.targetVersion === null ||
    compareVersions(options.version, options.targetVersion) > 0
  )
    return { action: "replace", target };
  return { action: "defer", target };
}

/**
 * The application menu's updates item for a visible installation. The
 * original's wording: "Downloading Update…" with no percentage, "Restart to
 * Update to 1.2" once staged, and a disabled "Last Update Attempt Failed" line
 * under the ordinary item after a failure (`failed`).
 */
export function updateMenuItem(
  status: AppUpdateStatus | undefined,
  visible = status?.supported ?? false,
): { label: string; enabled: boolean; failed?: boolean } | undefined {
  if (!visible) return undefined;
  if (status?.phase === "checking")
    return { label: "Checking for Updates…", enabled: false };
  if (status?.phase === "downloading")
    return { label: "Downloading Update…", enabled: false };
  if (status?.phase === "ready")
    return {
      label: status.version
        ? `Restart to Update to ${status.version}`
        : "Restart to Update",
      enabled: true,
    };
  if (status?.phase === "error")
    return { label: "Check for Updates…", enabled: true, failed: true };
  return { label: "Check for Updates…", enabled: true };
}
