import { useSyncExternalStore } from "react";
import { surface } from "../../shared/host";
import type { ClientUpdate } from "../../shared/client-policy";
import { updateBlocksSending } from "../../shared/client-release";
import { downloadPage } from "../../shared/external-links";
import { formatText, t } from "../i18n";
import { ArrowRight } from "../ui/glyphs";
import { CloseSmallIcon } from "../ui/icons";
import { DownloadTrayIcon } from "./policy-icons";

const dismissedKey = "claudex.updateDismissed";

/**
 * The version whose update notice the person put away, shared by the notice
 * above the account button and the one above the composer.
 */
const dismissal = {
  listeners: new Set<() => void>(),
  read() {
    try {
      return localStorage.getItem(dismissedKey) ?? "";
    } catch {
      return "";
    }
  },
  write(value: string) {
    try {
      if (value) localStorage.setItem(dismissedKey, value);
      else localStorage.removeItem(dismissedKey);
    } catch {
      /* The notice simply shows again next time. */
    }
    dismissal.listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void) {
    dismissal.listeners.add(listener);
    return () => void dismissal.listeners.delete(listener);
  },
};

/** Puts the update notices away for this version. */
export const dismissUpdate = (version: string) => dismissal.write(version);

/** The version whose update notice was put away ("" for none). */
export function useDismissedUpdate() {
  return useSyncExternalStore(dismissal.subscribe, dismissal.read, () => "");
}

/**
 * The notice stays closed for a version once dismissed; an enforced update
 * cannot be dismissed. The web app never shows it: reloading the page is
 * the update (W-UI-design §3.4).
 */
export function useUpdateNotice(update: ClientUpdate | undefined) {
  const dismissed = useDismissedUpdate();
  return {
    shown:
      surface !== "web" &&
      !!update &&
      (updateBlocksSending(update) || dismissed !== update.latestVersion),
    dismiss: () => update && dismissal.write(update.latestVersion),
    show: () => dismissal.write(""),
  };
}

/** Opens the update's download page through the main process, which checks it. */
export function openUpdateDownload(onError: (error: unknown) => void) {
  void Promise.resolve(window.desktop.openUpdateDownload?.()).catch(onError);
}

/**
 * Update prompt above the account button. An update that is only available,
 * with a download page, is the sidebar's one-line update strip: "Update
 * available", a click opens the download page, nothing to dismiss. A required
 * update, or one without a page, keeps its card: it says why and what to do.
 * This is the download fallback when the automatic updater cannot install this
 * release: the main process opens the administrator's https download page. Not
 * shown on the web, which has nothing to install.
 */
export function UpdateNotice({
  update,
  onDismiss,
  onError = () => {},
}: {
  update: ClientUpdate;
  onDismiss: () => void;
  onError?: (error: unknown) => void;
}) {
  if (surface === "web") return null;
  const required = update.state === "required";
  const blocks = updateBlocksSending(update);
  const download = Boolean(downloadPage(update));
  const version = update.latestVersion;
  if (!required && download)
    return (
      <button
        type="button"
        className="relaunch-update"
        title={formatText("Claudex {version} is available.", { version })}
        onClick={() => openUpdateDownload(onError)}
      >
        <span>{t("Update available")}</span>
        <ArrowRight aria-hidden="true" size={11} strokeWidth={2} />
      </button>
    );
  return (
    <div
      className={`update-notice ${update.state}`}
      role={blocks ? "alert" : "status"}
    >
      <DownloadTrayIcon className="update-notice-icon" />
      <div className="update-notice-text">
        <strong>
          {required ? t("Update required") : t("Update available")}
        </strong>
        <span>
          {blocks
            ? formatText(
                "This version is no longer supported. Install Claudex {version} to keep working.",
                { version },
              )
            : required
              ? formatText(
                  "Your administrator no longer supports this version. Install Claudex {version}.",
                  { version },
                )
              : formatText("Claudex {version} is available.", { version })}
          {!download && ` ${t("Ask your administrator for the installer.")}`}
        </span>
        {download && (
          <button
            type="button"
            className="update-notice-download"
            onClick={() => openUpdateDownload(onError)}
          >
            {t("Download")}
          </button>
        )}
      </div>
      {!blocks && (
        <button
          type="button"
          className="update-notice-close"
          aria-label={t("Dismiss")}
          onClick={onDismiss}
        >
          <CloseSmallIcon />
        </button>
      )}
    </div>
  );
}
