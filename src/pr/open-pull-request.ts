import type { Settings } from "../../shared/types";
import { preference } from "../../shared/settings-extras";

/**
 * Opens a pull request's page: in the default browser when Settings → Claude
 * Code → Open pull requests in browser is on, else the way the window opens
 * links (the built-in browser when it takes links, else the default one after
 * the usual question).
 */
export function openPullRequest(
  url: string,
  settings: Settings | undefined,
  openLink: (url: string) => void,
) {
  if (settings && preference(settings, "prOpenInBrowser"))
    void window.desktop?.openExternal(url);
  else openLink(url);
}
