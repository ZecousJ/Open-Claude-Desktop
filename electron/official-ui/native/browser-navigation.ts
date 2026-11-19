import type { WebContents } from "electron";
import type { NativeHost } from "./host";

export function navigationState({ navigationHistory }: WebContents) {
  return {
    canGoBack: navigationHistory.canGoBack(),
    canGoForward: navigationHistory.canGoForward(),
  };
}

export function registerBrowserNavigation(host: NativeHost) {
  const contents = () => {
    const window = host.caller;
    if (!window) throw Error("This account window has retired.");
    return window.webContents;
  };
  const read = () => navigationState(contents());
  host.on("BrowserNavigation.navigationState_$store$_getState", read);
  host.on("BrowserNavigation.navigationState_$store$_getStateSync", read);
  host.on("BrowserNavigation.goBack", () => contents().navigationHistory.goBack());
  host.on("BrowserNavigation.goForward", () => contents().navigationHistory.goForward());
}

export function observeBrowserNavigation(
  contents: WebContents,
  origin: string,
  changed: (state: ReturnType<typeof navigationState>) => void,
) {
  const publish = (_event: unknown, url: string) => {
    if (URL.parse(url)?.origin === origin) changed(navigationState(contents));
  };
  const inPage = (event: unknown, url: string, isMainFrame: boolean) => {
    if (isMainFrame) publish(event, url);
  };
  contents.on("did-navigate", publish);
  contents.on("did-navigate-in-page", inPage);
  return () => {
    contents.removeListener("did-navigate", publish);
    contents.removeListener("did-navigate-in-page", inPage);
  };
}
