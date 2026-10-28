import type { AppContext } from "../app/app-context";
import { hostedUiUrl } from "../app/hosted-ui";

interface MicrophonePermission {
  requesterIsMainWindow: boolean;
  requesterIsQuickEntry?: boolean;
  isMainFrame: boolean;
  requestingUrl: string | undefined;
  mainUrl: string;
  mediaTypes: readonly string[] | undefined;
}

/** Only an owned app or Quick Entry top-level renderer may capture microphone audio. */
export function mayUseMicrophone(input: MicrophonePermission) {
  if (
    (!input.requesterIsMainWindow && !input.requesterIsQuickEntry) ||
    !input.isMainFrame ||
    input.requestingUrl !== input.mainUrl ||
    input.mediaTypes?.length !== 1 ||
    input.mediaTypes[0] !== "audio"
  )
    return false;
  try {
    const url = new URL(input.mainUrl);
    const page = input.requesterIsQuickEntry ? "quick.html" : "index.html";
    const hosted = hostedUiUrl(page);
    if (hosted) {
      const expected = new URL(hosted);
      if (url.origin === expected.origin && url.pathname === expected.pathname)
        return true;
    }
    return url.protocol === "claudex-app:"
      ? url.host === "ui" && url.pathname.endsWith(`/${page}`)
      : url.protocol === "file:"
        ? url.pathname.endsWith(`/dist/${page}`)
        : url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The main window's media permission requests and checks (package C6):
 * recording is allowed while the administrator allows voice (`voiceAllowed`,
 * false while signed out) and the request is the app's own.
 */
export function microphoneRequestAllowed(
  _ctx: AppContext,
  voiceAllowed: boolean,
  input: MicrophonePermission,
) {
  return voiceAllowed && mayUseMicrophone(input);
}
