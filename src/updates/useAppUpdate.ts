import { useEffect, useState } from "react";
import type { AppUpdateStatus } from "../../shared/app-update-api";
import { type ClientUpdate } from "../../shared/client-policy";
import { compareVersions } from "../../shared/client-policy-rules";
import { surface } from "../../shared/host";

/**
 * Claudex's own update status: read once, then from every "app-update" event.
 * Undefined while unknown and where the bridge has no such call (the web, an
 * older build): the window then offers no Relaunch.
 */
export function useAppUpdate(): AppUpdateStatus | undefined {
  const [status, setStatus] = useState<AppUpdateStatus>();
  useEffect(() => {
    if (surface === "web") return;
    let live = true;
    const desktop = window.desktop;
    Promise.resolve()
      .then(() => desktop?.appUpdateStatus?.())
      .then((value) => live && value && setStatus(value))
      .catch(() => {});
    const off = desktop?.onEvent?.((event) => {
      if (live && event.type === "app-update") setStatus(event.status);
    });
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return status;
}

/** Releases the service announced that the updater was asked to look for again. */
const rechecked = new Set<string>();

/**
 * The service announces `version` and the updater has not got it: its last
 * check (at launch, then every four hours) came before the release, found
 * an older one, or failed.
 */
function behind(status: AppUpdateStatus, version: string) {
  if (compareVersions(version, status.currentVersion) <= 0) return false;
  if (status.phase === "idle" || status.phase === "checking") return false;
  return !(
    (status.phase === "downloading" || status.phase === "ready") &&
    status.version &&
    compareVersions(status.version, version) >= 0
  );
}

/**
 * A release the updater has not found yet is looked for at once, the moment the
 * service announces it, once per version.
 */
export function useRecheckForRelease(
  status: AppUpdateStatus | undefined,
  update: ClientUpdate | undefined,
) {
  const version = update?.latestVersion;
  useEffect(() => {
    if (!status?.supported || !version || rechecked.has(version)) return;
    if (behind(status, version)) recheckFor(version);
  }, [status?.supported, status?.phase, status?.version, version]);
}

/** Asks the updater to look for `version` now; until it answers, it counts as updating. */
export function recheckFor(version: string) {
  rechecked.add(version);
  void Promise.resolve()
    .then(() => window.desktop?.checkForAppUpdate?.())
    .catch(() => {});
}

/**
 * Claudex updates itself, so the window offers Relaunch (when ready) instead
 * of the download page: while the updater checks (it is told of a newer
 * release at once), fetches or has staged it, and while a check for a
 * release it has not found yet is still to come (useRecheckForRelease). The
 * download page stays the way out when it cannot (unsupported here, or that
 * check failed or found nothing).
 */
export function selfUpdating(
  status: AppUpdateStatus | undefined,
  update?: ClientUpdate,
): boolean {
  if (!status?.supported) return false;
  if (status.phase === "idle" || status.phase === "checking") return true;
  if (
    update &&
    behind(status, update.latestVersion) &&
    !rechecked.has(update.latestVersion)
  )
    return true;
  if (status.phase !== "downloading" && status.phase !== "ready") return false;
  if (!status.version) return false;
  return !update || compareVersions(status.version, update.latestVersion) >= 0;
}

export const relaunchReady = (status: AppUpdateStatus | undefined) =>
  !!status?.supported && status.phase === "ready" && !!status.version;

export function relaunchToUpdate(
  onError: (error: unknown) => void,
  options?: { interrupt?: boolean },
) {
  void Promise.resolve()
    .then(() => window.desktop.relaunchToUpdate(options))
    .catch(onError);
}
