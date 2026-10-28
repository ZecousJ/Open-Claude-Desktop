/**
 * Where a Browser panel page may go (R8). Every main-frame navigation, a
 * redirect included, is checked here; so are the windows a page opens and
 * each request against the administrator's blocked domains.
 */
import { fileAllowed, hostBlocked } from "../../shared/browser";

export interface GuardOptions {
  /** Folders the person chose with Open HTML file… (their files may open). */
  fileRoots: readonly string[];
  /** The administrator's blocked domains (policy `browser.blockedDomains`). */
  blockedDomains: readonly string[];
}

export type NavigationDecision =
  { allow: true } | { allow: false; reason: "scheme" | "blocked" | "file" };

/** Whether a page may load `url` in its main frame. */
export function navigationAllowed(
  url: string,
  options: GuardOptions,
): NavigationDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allow: false, reason: "scheme" };
  }
  switch (parsed.protocol) {
    case "http:":
    case "https:":
      if (parsed.username || parsed.password)
        return { allow: false, reason: "scheme" };
      return hostBlocked(parsed.host, options.blockedDomains)
        ? { allow: false, reason: "blocked" }
        : { allow: true };
    case "about:":
      return parsed.href === "about:blank"
        ? { allow: true }
        : { allow: false, reason: "scheme" };
    case "file:":
      return fileAllowed(parsed, options.fileRoots)
        ? { allow: true }
        : { allow: false, reason: "file" };
    default:
      return { allow: false, reason: "scheme" };
  }
}

/**
 * What happens to a window a page opens: web pages become a new tab of the
 * same panel; anything else is refused.
 */
export function windowOpenDecision(
  url: string,
  options: GuardOptions,
): "tab" | "deny" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "deny";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return parsed.protocol === "file:" && navigationAllowed(url, options).allow
      ? "tab"
      : "deny";
  return navigationAllowed(url, options).allow ? "tab" : "deny";
}

/**
 * Whether a request (any frame, any resource) goes to a blocked domain.
 * Chromium's own pages and data/blob resources are never blocked.
 */
export function requestBlocked(url: string, blockedDomains: readonly string[]) {
  if (!blockedDomains.length) return false;
  try {
    const parsed = new URL(url);
    if (!/^(?:https?|wss?):$/.test(parsed.protocol)) return false;
    return hostBlocked(parsed.host, blockedDomains);
  } catch {
    return false;
  }
}

/** A navigation event's details (Electron's `will-navigate` family). */
export interface NavigationEvent {
  url: string;
  isMainFrame: boolean;
  preventDefault(): void;
}

/** The events of a page's webContents the guard listens to. */
export interface GuardedContents {
  on(
    event: "will-navigate" | "will-redirect" | "will-frame-navigate",
    listener: (event: NavigationEvent) => void,
  ): unknown;
  on(
    event: "will-attach-webview",
    listener: (event: { preventDefault(): void }) => void,
  ): unknown;
  setWindowOpenHandler(
    handler: (details: { url: string; disposition: string }) => {
      action: "deny";
    },
  ): void;
}

/**
 * Guards one page: main-frame navigations outside the rules are stopped
 * (`refused` gets the url and why), frames never load blocked domains or
 * this computer's files, a page's new windows become tabs (`openTab`), and
 * pages never attach <webview>s.
 */
export function guardContents(
  contents: GuardedContents,
  options: () => GuardOptions,
  handlers: {
    routeLink?(url: string): boolean;
    refused(url: string, reason: "scheme" | "blocked" | "file"): void;
    openTab(url: string, foreground: boolean): void;
  },
) {
  const mainFrame = (event: NavigationEvent, route = false) => {
    const decision = navigationAllowed(event.url, options());
    if (route && decision.allow && handlers.routeLink?.(event.url)) {
      event.preventDefault();
      return;
    }
    if (decision.allow) return;
    event.preventDefault();
    handlers.refused(event.url, decision.reason);
  };
  contents.on("will-navigate", (event) => {
    if (event.isMainFrame) mainFrame(event, true);
  });
  contents.on("will-redirect", (event) => {
    if (event.isMainFrame) mainFrame(event);
    else if (subframeRefused(event.url, options())) event.preventDefault();
  });
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && subframeRefused(event.url, options()))
      event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (navigationAllowed(url, options()).allow && handlers.routeLink?.(url))
      return { action: "deny" };
    if (windowOpenDecision(url, options()) === "tab")
      handlers.openTab(url, disposition !== "background-tab");
    return { action: "deny" };
  });
}

/**
 * Frames inside a page load what the page asks for (data:, blob: and
 * about:srcdoc included) except blocked domains and this computer's files.
 */
export function subframeRefused(url: string, options: GuardOptions) {
  if (requestBlocked(url, options.blockedDomains)) return true;
  if (/^\s*file:/i.test(url)) return !fileAllowed(url, options.fileRoots);
  return /^\s*(?:chrome|devtools|chrome-extension):/i.test(url);
}
