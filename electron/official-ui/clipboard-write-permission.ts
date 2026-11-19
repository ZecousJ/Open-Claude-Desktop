import type { Session, WebContents } from "electron";

// Separate from the page (0) and Electron's preload isolation world (999).
// This world exposes no bindings and only inspects native document activation.
export const clipboardActivationWorld = 1004;
const activationProbe =
  "navigator.userActivation.isActive === true && document.hasFocus()";

/** A write-only, per-request gate for an explicitly clicked official UI copy. */
export function installOfficialClipboardWritePermission(
  session: Pick<
    Session,
    "setPermissionCheckHandler" | "setPermissionRequestHandler"
  >,
  trustedOrigin: (contents: WebContents) => string | undefined,
  timeoutMs = 1000,
  microphoneOrigin?: (contents: WebContents) => string | undefined,
) {
  const microphoneAllowed = (
    contents: WebContents | null,
    requestingUrl: string | undefined,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame || !contents || contents.isDestroyed() || !requestingUrl)
      return false;
    const origin = microphoneOrigin?.(contents);
    return !!origin && requestingUrl === contents.mainFrame.url &&
      new URL(requestingUrl).origin === origin;
  };
  session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permission === "media" && details.mediaType === "audio" &&
    microphoneAllowed(contents, details.requestingUrl, details.isMainFrame),
  );
  session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      if (permission === "media" && "mediaTypes" in details) {
        callback(details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio" &&
          microphoneAllowed(contents, details.requestingUrl, details.isMainFrame));
        return;
      }
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (allowed: boolean) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        callback(allowed);
      };
      try {
        if (
          permission !== "clipboard-sanitized-write" ||
          details.isMainFrame !== true ||
          !contents ||
          contents.isDestroyed() ||
          !contents.isFocused()
        )
          return finish(false);
        const origin = trustedOrigin(contents);
        const frame = contents.mainFrame;
        const url = frame.url,
          process = frame.processId,
          routing = frame.routingId;
        const current = () => {
          try {
            return (
              !contents.isDestroyed() &&
              contents.isFocused() &&
              trustedOrigin(contents) === origin &&
              !!origin &&
              contents.mainFrame === frame &&
              frame.processId === process &&
              frame.routingId === routing &&
              frame.url === url &&
              details.requestingUrl === url &&
              new URL(url).origin === origin &&
              ["http:", "https:"].includes(new URL(url).protocol)
            );
          } catch {
            return false;
          }
        };
        if (!current()) return finish(false);
        timer = setTimeout(() => finish(false), timeoutMs);
        // Explicit false is essential: checking must never manufacture a user gesture.
        void contents
          .executeJavaScriptInIsolatedWorld(
            clipboardActivationWorld,
            [{ code: activationProbe }],
            false,
          )
          .then(
            (active) => finish(active === true && current()),
            () => finish(false),
          );
      } catch {
        finish(false);
      }
    },
  );
}
